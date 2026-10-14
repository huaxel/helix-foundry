// Data Connection job handlers (upload, sync), dispatched by the worker in jobs.ts.
import type { Resource } from "../../../packages/shared/src/index.js";
import { jobProgress } from "./setup-jobs.js";
import { prepareSourceSync, sourceSyncDefaults } from "./source-sync.js";
import { transaction, now, resource, type Store } from "./store.js";
import { discover, importSource } from "./connectors.js";
import { ingestFile, removeStagedInput } from "./datasets.js";
import { seal, unseal } from "./security.js";

export async function runUploadJob(store: Store, scope: string, job: Resource) {
  await jobProgress(store, scope, job.id, {
    message: "Importing and profiling complete file",
  });
  await ingestFile(
    store,
    scope,
    job.name,
    job.data.file,
    undefined,
    job.data.datasetId,
    job.id,
    {
      jobId: job.id,
      partitionColumn: job.data.partitionColumn,
    },
  );
}

export async function runSyncJob(store: Store, scope: string, job: Resource) {
  let source = await store.get(scope, job.data.sourceId);
  if (!source) throw new Error("Source missing");
  source = await prepareSourceSync(store, scope, source);
  const changeCounter = Number(source.data.sync?.changes || 0);
  const imported = await importSource(
    scope,
    source.data.kind,
    unseal(source.data.secret),
    (p) => jobProgress(store, scope, job.id, p),
  );
  const ds = await (async () => {
    try {
      return await ingestFile(
        store,
        scope,
        source.name,
        imported.file || "",
        source.id,
        source.data.datasetId || "source_" + source.id,
        job.id,
        {
          schema: imported.schema,
          jobId: job.id,
          partitionColumn: source.data.partitionColumn,
          localSource:
            imported.sourcePath && imported.sourceFingerprint
              ? {
                  path: imported.sourcePath,
                  fingerprint: imported.sourceFingerprint,
                }
              : undefined,
        },
      );
    } finally {
      if (imported.file) await removeStagedInput(scope, imported.file);
    }
  })();
  await transaction(store, scope, async (tx) => {
    const s = await tx.get(source.id);
    if (s && s.data.secret === source.data.secret)
      tx.update(s, {
        ...s.data,
        datasetId: ds.id,
        lastSync: now(),
        lastError: null,
        sync: s.data.sync
          ? { ...s.data.sync, applied: changeCounter }
          : undefined,
      });
  });
}
// Auto-import declared Parquet mounts: any matching file without a source
// becomes a source with a queued sync job. Idempotent, runs on worker
// startup and periodically. Jobs carry no actor so the worker runs them as
// system work; sources stay on manual sync (no automatic refresh).
export async function syncLocalSources(store: Store): Promise<number> {
  let files: string[];
  try {
    const found = (await discover("local", {})) as {
      tables?: { name: string }[];
    };
    files = (found.tables || []).map((t) => String(t.name));
  } catch {
    // Mount missing, unreadable, or over the file cap.
    return 0;
  }
  if (!files.length) return 0;
  let created = 0;
  for (const workspace of await store.list("global", "workspaceRef")) {
    const scope = workspace.id;
    const have = new Set(
      (await store.list(scope, "source"))
        .filter((s) => s.data.kind === "local")
        .map((s) => s.name),
    );
    const missing = files.filter((name) => !have.has(name));
    if (!missing.length) continue;
    await transaction(store, scope, async (tx) => {
      const current = new Set(
        (await tx.list("source"))
          .filter((s) => s.data.kind === "local")
          .map((s) => s.name),
      );
      // Bulk auto-imports stay out of setup gating; the user explicitly
      // includes the ones they want, and only those block Continue.
      const ws = await tx.get("workspace");
      const excluded = new Set<string>(
        (ws?.data?.onboarding?.excludedIds || []) as string[],
      );
      let excludedChanged = false;
      for (const filepath of missing) {
        if (current.has(filepath)) continue;
        const source = tx.put(
          resource(scope, "source", filepath, {
            kind: "local",
            connectionId: "connection_local-auto",
            connectionName: "Local Parquet",
            secret: seal({ key: filepath }),
            discovery: { tables: [{ name: filepath }] },
            ...sourceSyncDefaults("local", null),
          }),
        );
        const job = tx.put(
          resource(scope, "job", source.name, {
            type: "sync",
            sourceId: source.id,
            status: "queued",
            progress: { message: "Waiting to import" },
          }),
        );
        current.add(filepath);
        created++;
        if (!excluded.has(source.id) || !excluded.has(job.id)) {
          excluded.add(source.id);
          excluded.add(job.id);
          excludedChanged = true;
        }
      }
      if (excludedChanged && ws) {
        tx.update(ws, {
          ...ws.data,
          onboarding: {
            ...(ws.data.onboarding || {}),
            excludedIds: [...excluded],
          },
        });
      }
    });
  }
  return created;
}
