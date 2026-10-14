import { randomUUID } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";
import { execute } from "./executor.js";
import { resource, transaction, now, type Store } from "./store.js";
import type {
  DatasetProfile,
  Resource,
} from "../../../packages/shared/src/index.js";
import {
  datasetTable,
  datasetAliases,
} from "../../../packages/shared/src/index.js";
import { assert, digest } from "./security.js";
import { SAMPLE_SET, sampleDatasets } from "./sample-data.js";
// A pipeline's output is registered as a derived dataset under this id.
export const pipelineId = (name: string) =>
  "pipeline_" + digest(name).slice(0, 16);
// Sample datasets loaded at once; the executor handles a few ingests in parallel.
export const SAMPLE_LOADS = 3;
const compactProfile = (profile: DatasetProfile): DatasetProfile => ({
  ...profile,
  sample: Array.isArray(profile?.sample) ? profile.sample.slice(0, 3) : [],
});
export async function removeStagedInput(scope: string, file: string) {
  if (!file) return;
  try {
    await rm(resolve(config.dataDir, "incoming", scope, file), { force: true });
  } catch (error) {
    console.warn(
      "Unable to remove staged import:",
      error instanceof Error ? error.message : "filesystem error",
    );
  }
}
export async function ingestFile(
  store: Store,
  scope: string,
  name: string,
  file: string,
  sourceId?: string,
  datasetId?: string,
  versionId?: string,
  opts: {
    schema?: { name: string; type: string }[];
    jobId?: string;
    localSource?: {
      path: string;
      fingerprint: { size: number; mtimeMs: number };
    };
    approximateProfile?: boolean;
    partitionColumn?: string;
  } = {},
) {
  const {
    schema,
    jobId,
    localSource,
    approximateProfile = false,
    partitionColumn,
  } = opts;
  // Fail fast with a 400 (not a DuckDB binder error after an executor
  // round-trip): sync routes surface this immediately, jobs record it.
  assert(
    partitionColumn === undefined ||
      (partitionColumn.length >= 1 &&
        partitionColumn.length <= 100 &&
        !partitionColumn.includes("\0")),
    "Invalid partition column",
  );
  const version =
    versionId === jobId && jobId
      ? "snapshot_" + jobId
      : versionId || randomUUID();
  if (versionId && (await store.get(scope, version))) {
    const existing = datasetId ? await store.get(scope, datasetId) : undefined;
    if (existing) {
      if (!localSource && file) await removeStagedInput(scope, file);
      return existing;
    }
  }
  // Incremental refresh: on a re-ingest of a partitioned dataset whose current
  // version carries content fingerprints, pass them so the engine hard-links
  // unchanged partition files instead of re-writing them (dedups + faster).
  let reusePartitions:
    | { key: string; file: string; fingerprint: string }[]
    | undefined;
  if (partitionColumn && datasetId) {
    const existing = await store.get(scope, datasetId);
    const activeVerId = existing?.data.activeVersion as string | undefined;
    if (activeVerId) {
      const activeVer = await store.get(scope, activeVerId);
      const parts = activeVer?.data.partitions as
        | { key: string; file: string; fingerprint?: string }[]
        | undefined;
      if (Array.isArray(parts) && parts.length) {
        const withFp = parts.filter(
          (p) => typeof p.fingerprint === "string" && p.fingerprint.length,
        );
        if (withFp.length)
          reusePartitions = withFp.map((p) => ({
            key: p.key,
            file: p.file,
            fingerprint: p.fingerprint as string,
          }));
      }
    }
  }
  const r = await execute({
    mode: "ingest",
    scope,
    version,
    file: localSource ? undefined : file,
    sourcePath: localSource?.path,
    sourceFingerprint: localSource?.fingerprint,
    schema,
    limit: 3,
    approximateProfile,
    ...(partitionColumn ? { partitionColumn } : {}),
    ...(reusePartitions ? { reusePartitions } : {}),
  });
  const storedProfile = compactProfile(r.profile);
  let imported: Resource;
  try {
    imported = await transaction(store, scope, async (tx) => {
      if (jobId)
        assert(
          (await tx.get(jobId))?.data.status !== "canceled",
          "Import canceled",
          409,
        );
      const old = datasetId ? await tx.get(datasetId) : undefined;
      const ds =
        old ||
        resource(scope, "dataset", name, { sourceId, versions: [] }, datasetId);
      const oldProfile = old?.data.profile;
      const drift =
        oldProfile &&
        JSON.stringify(oldProfile.columns.map((x: any) => [x.name, x.type])) !==
          JSON.stringify(r.profile.columns.map((x) => [x.name, x.type]));
      const v = resource(
        scope,
        "version",
        name,
        {
          datasetId: ds.id,
          profile: storedProfile,
          ...(partitionColumn
            ? { partitionColumn, partitions: r.partitions }
            : localSource
              ? {
                  sourcePath: localSource.path,
                  sourceFingerprint: localSource.fingerprint,
                }
              : { file: version + ".parquet" }),
        },
        version,
      );
      tx.put(v);
      const data = {
        ...ds.data,
        ...(jobId ? { importJobId: jobId } : {}),
        profile: drift ? compactProfile(oldProfile) : storedProfile,
        activeVersion: drift ? ds.data.activeVersion : version,
        pendingVersion: drift ? version : null,
        versions: [version, ...ds.data.versions],
        ...(partitionColumn
          ? { sourcePath: undefined, sourceFingerprint: undefined }
          : localSource
            ? {
                sourcePath: localSource.path,
                sourceFingerprint: localSource.fingerprint,
              }
            : { sourcePath: undefined, sourceFingerprint: undefined }),
        sourceId: sourceId || ds.data.sourceId,
        table: datasetTable(ds.id),
        lastSync: now(),
      };
      const updated = tx.put({ ...ds, revision: ds.revision + 1, updatedAt: now(), data });
      const qualityIssues = oldProfile
        ? r.profile.columns.flatMap((c) => {
            const before = oldProfile.columns.find(
              (x: any) => x.name === c.name,
            );
            return before
              ? [
                  ...(before.primaryKey && !c.primaryKey
                    ? [`${c.name} lost uniqueness or contains nulls`]
                    : []),
                  ...(c.nulls / Math.max(1, r.profile.rows) >
                  before.nulls / Math.max(1, oldProfile.rows)
                    ? [`${c.name} null rate increased`]
                    : []),
                ]
              : [];
          })
        : [];
      if (oldProfile && oldProfile.fingerprint !== r.profile.fingerprint)
        tx.put(
          resource(
            scope,
            "finding",
            drift ? "Schema changed: " + name : "Data refreshed: " + name,
            {
              datasetId: ds.id,
              version,
              kind: drift ? "schema" : "refresh",
              dismissed: false,
              evidence: {
                before: oldProfile.rows,
                after: r.profile.rows,
                qualityIssues,
                duplicateRows: r.profile.duplicateRows,
              },
              fingerprint: r.profile.fingerprint,
            },
          ),
        );
      return updated;
    });
  } catch (error) {
    // Execution may have written this unique version before metadata failed.
    await rm(resolve(config.dataDir, "datasets", scope, `${version}.parquet`), {
      force: true,
    }).catch(() => {});
    if (partitionColumn)
      await rm(
        resolve(config.dataDir, "datasets", scope, version),
        { recursive: true, force: true },
      ).catch(() => {});
    throw error;
  }
  // The durable Parquet snapshot is committed; the staged source copy is no
  // longer needed. Failed imports retain it so queued uploads can be retried.
  if (!localSource && file) await removeStagedInput(scope, file);
  await pruneVersions(store, scope, imported.id);
  return imported;
}

export const VERSION_RETENTION = 10;

// Keep a dataset's version history bounded: drop version resources beyond the
// retention window together with their on-disk Parquet files. Retained
// versions hard-link shared partition files, so removing an old version's
// directory only reclaims disk once no retained version references the same
// inodes. activeVersion and pendingVersion are never dropped, even if they
// fall outside the window.
export async function pruneVersions(
  store: Store,
  scope: string,
  datasetId: string,
): Promise<void> {
  await transaction(store, scope, async (tx) => {
    const ds = await tx.get(datasetId);
    if (!ds || ds.kind !== "dataset") return;
    const versions: string[] = Array.isArray(ds.data.versions)
      ? ds.data.versions
      : [];
    if (versions.length <= VERSION_RETENTION) return;
    const keep = new Set(
      [ds.data.activeVersion, ds.data.pendingVersion].filter(Boolean),
    );
    const kept = versions.slice(0, VERSION_RETENTION);
    const dropped = versions
      .slice(VERSION_RETENTION)
      .filter((v) => !keep.has(v));
    if (!dropped.length) return;
    for (const v of dropped) {
      const ver = await tx.get(v);
      if (!ver || ver.kind !== "version") continue;
      const files = [
        ...((ver.data.partitions as { file: string }[] | undefined) ?? []).map(
          (part) => part.file,
        ),
        ...(typeof ver.data.file === "string" ? [ver.data.file] : []),
      ];
      for (const f of files)
        await rm(resolve(config.dataDir, "datasets", scope, f), {
          force: true,
        });
      // Partitioned versions keep their files in a per-version directory.
      await rm(resolve(config.dataDir, "datasets", scope, v), {
        recursive: true,
        force: true,
      }).catch(() => {});
      tx.delete(v);
    }
    tx.update(ds, { ...ds.data, versions: kept });
  });
}
export async function ingestRows(
  store: Store,
  scope: string,
  name: string,
  rows: unknown[],
  sourceId?: string,
  datasetId?: string,
  partitionColumn?: string,
) {
  assert(rows.length > 0, "Provide at least one row");
  const dir = resolve(config.dataDir, "incoming", scope);
  await mkdir(dir, { recursive: true });
  const file = randomUUID() + ".jsonl";
  await writeFile(
    resolve(dir, file),
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  try {
    return await ingestFile(
      store,
      scope,
      name,
      file,
      sourceId,
      datasetId,
      undefined,
      { partitionColumn },
    );
  } catch (error) {
    await removeStagedInput(scope, file);
    throw error;
  }
}
export async function datasetInputs(
  store: Store,
  scope: string,
  ids: string[],
) {
  const results = [],
    generation = (await store.get(scope, "workspace"))?.data.activeGeneration;
  for (const id of [...new Set(ids)]) {
    const ds = await store.get(scope, id);
    assert(
      ds?.kind === "dataset" &&
        ds.data.activeVersion &&
        (!ds.data.generation || ds.data.generation === generation),
      "Dataset is unavailable",
      404,
    );
    const version = await store.get(scope, ds.data.activeVersion as string);
    assert(version?.kind === "version", "Dataset version is unavailable", 404);
    const vd = version.data;
    results.push({
      table: datasetTable(id),
      version: ds.data.activeVersion as string,
      ...(vd.partitions && vd.partitions.length
        ? {
            // Partitioned version: the full (unpruned) set of partition files
            // plus the manifest, so queryDatasets can prune by partition-key
            // filters before the executor opens any files.
            files: vd.partitions.map((p: any) => p.file),
            partitionColumn: vd.partitionColumn,
            partitions: vd.partitions,
          }
        : {}),
      ...(vd.sourcePath
        ? { sourcePath: vd.sourcePath, sourceFingerprint: vd.sourceFingerprint }
        : {}),
      aliases: datasetAliases(ds.name),
    });
  }
  return results;
}
export async function queryDatasets(
  store: Store,
  scope: string,
  ids: string[],
  sql: string,
  opts: {
    limit?: number;
    offset?: number;
    persist?: boolean;
    filters?: {
      datasetId: string;
      column: string;
      value: string | number | boolean | null;
    }[];
  } = {},
) {
  const inputs = await datasetInputs(store, scope, ids);
  for (const filter of opts.filters || []) {
    assert(ids.includes(filter.datasetId), "Filter input is not declared");
    const ds = await store.get(scope, filter.datasetId);
    assert(
      ds?.data.profile.columns.some((c: any) => c.name === filter.column),
      "Unknown filter column",
    );
  }
  const filtered = inputs.map((input: any) => ({
    ...input,
    filters: (opts.filters || []).filter(
      (f) => datasetTable(f.datasetId) === input.table,
    ),
  }));
  // Partition pruning: when a filter targets an input's partition column, keep
  // only the partitions whose key matches a filter value. A filter on any other
  // column still reads every partition and is applied as a WHERE by the engine.
  const uniqueIds = [...new Set(ids)];
  const pruned = filtered.map((input: any) => {
    if (!input.partitionColumn || !input.files || !input.partitions)
      return input;
    const pf = (input.filters || []).filter(
      (f: any) => f.column === input.partitionColumn,
    );
    if (pf.length === 0) return input; // no partition-key filter -> all partitions
    // A null filter matches the null partition (stored under key "").
    const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    const keys = new Set(pf.map((f: any) => norm(f.value)));
    const kept = (input.partitions as { key: string; file: string }[]).filter(
      (p) => keys.has(norm(p.key)),
    );
    if (kept.length === 0 && uniqueIds.length > 1) {
      // Several inputs: the SQL may ignore this table or outer-join it, so a
      // pruned-to-zero set must not zero the whole result. Keep every
      // partition and let the engine's WHERE (still attached to the input)
      // filter it to nothing — correct for joins and unreferenced tables.
      // read_parquet([]) throws, so an empty list can never reach the engine.
      return input;
    }
    return { ...input, files: kept.map((p) => p.file) };
  });
  if (pruned.some((i: any) => i.partitions && (i.files || []).length === 0)) {
    // Single-input query whose partition-key filter matches no partitions ->
    // zero rows without an executor round-trip (multi-input queries never
    // reach here: they fall back to the full file set above). Build the
    // empty result from the first dataset's profile so the columns are right.
    const ds = await store.get(scope, uniqueIds[0]);
    const profile = ds?.data.profile;
    return {
      profile: profile
        ? { ...profile, rows: 0, duplicateRows: 0, sample: [] }
        : { rows: 0, columns: [], sample: [], fingerprint: "" },
      version: "",
      rows: [],
      citations: inputs.map((input, i) => ({
        datasetId: [...new Set(ids)][i],
        version: input.version,
      })),
      state: "dataset_snapshot",
    };
  }
  // Send only the executor-relevant input fields (drop the manifest).
  const executorInputs = pruned.map((i: any) => ({
    table: i.table,
    version: i.version,
    ...(i.files ? { files: i.files } : {}),
    ...(i.sourcePath
      ? { sourcePath: i.sourcePath, sourceFingerprint: i.sourceFingerprint }
      : {}),
    ...(i.aliases ? { aliases: i.aliases } : {}),
    ...(i.filters?.length ? { filters: i.filters } : {}),
  }));
  const result = await execute({
    mode: "query",
    scope,
    inputs: executorInputs,
    sql,
    version: randomUUID(),
    limit: opts.limit,
    offset: opts.offset,
    persist: opts.persist,
  });
  return {
    ...result,
    citations: inputs.map((input, i) => ({
      datasetId: [...new Set(ids)][i],
      version: input.version,
    })),
    state: "dataset_snapshot",
  };
}

// A second request while samples load (a client resuming a slow load) waits for
// the running one instead of ingesting the same datasets again.
const seeding = new Map<string, Promise<unknown>>();
// With advance, setup moves to the Outcome step before loading so the client can
// show loading progress (onboardingState.sampleProgress) right away.
export async function seedDemo(
  store: Store,
  scope: string,
  opts: { advance?: boolean } = {},
) {
  const running = seeding.get(scope);
  const run = (running ? running.catch(() => {}) : Promise.resolve()).then(() =>
    seedSamples(store, scope, opts),
  );
  seeding.set(scope, run);
  try {
    return await run;
  } finally {
    if (seeding.get(scope) === run) seeding.delete(scope);
  }
}
async function seedSamples(
  store: Store,
  scope: string,
  opts: { advance?: boolean },
) {
  const samples = sampleDatasets();
  const sampleIds = await transaction(store, scope, async (tx) => {
    const workspace = (await tx.get("workspace"))!;
    const onboarding = {
      ...workspace.data.onboarding,
      ...(opts.advance ? { step: "outcome" } : {}),
    };
    if (workspace.data.sampleSet === SAMPLE_SET) {
      if (opts.advance) tx.update(workspace, { ...workspace.data, onboarding });
      return workspace.data.sampleDatasetIds as Record<string, string>;
    }
    // An earlier sample set is left in place but hidden from setup.
    const retired = Object.values(
      (workspace.data.sampleDatasetIds || {}) as Record<string, string>,
    );
    const ids = Object.fromEntries(
      samples.map((sample) => [sample.name, randomUUID()]),
    );
    for (const id of retired) {
      const old = await tx.get(id);
      if (old) tx.update(old, { ...old.data, retiredSample: true });
    }
    tx.update(workspace, {
      ...workspace.data,
      sampleSet: SAMPLE_SET,
      sampleDatasetIds: ids,
      onboarding: retired.length
        ? {
            ...onboarding,
            excludedIds: [
              ...new Set([...(onboarding.excludedIds || []), ...retired]),
            ],
          }
        : onboarding,
    });
    return ids;
  });
  // A few at a time, in order, so the loading feed fills from the top.
  const out: Resource[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < samples.length; i = next++) {
      const sample = samples[i];
      const existing = await store.get(scope, sampleIds[sample.name]);
      const dataset = existing?.data.activeVersion
        ? existing
        : await ingestRows(
            store,
            scope,
            sample.name,
            sample.rows,
            undefined,
            sampleIds[sample.name],
          );
      out[i] = await transaction(store, scope, async (tx) => {
        const current = (await tx.get(dataset.id))!;
        return current.data.sampleData
          ? current
          : tx.update(
              { ...current, description: sample.description },
              {
                ...current.data,
                sampleData: true,
                sampleSource: sample.source,
              },
            );
      });
    }
  };
  await Promise.all([...Array(SAMPLE_LOADS)].map(worker));
  await transaction(store, scope, async (tx) => {
    const workspace = (await tx.get("workspace"))!;
    const onboarding = workspace.data.onboarding || {};
    const excluded: string[] = onboarding.excludedIds || [];
    const restored = new Set(Object.values(sampleIds));
    if (excluded.some((id) => restored.has(id)))
      tx.update(workspace, {
        ...workspace.data,
        onboarding: {
          ...onboarding,
          excludedIds: excluded.filter((id) => !restored.has(id)),
          recommendationRunId: null,
          buildRunId: null,
          ontologySuggestion: null,
          ontologyRunId: null,
          ontology: null,
        },
      });
  });
  return out;
}
