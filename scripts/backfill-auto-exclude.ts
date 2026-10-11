import "dotenv/config";
import { store, transaction } from "../apps/api/src/store.js";

// One-time repair: exclude bulk auto-imported local sources (and their jobs
// and datasets) from setup gating, so they never block Continue. Manual
// imports are untouched. Excluded data still imports and stays available;
// explicitly re-including an item in the UI is a one-click undo.
// Dry run by default; pass --apply to update.
const apply = process.argv.includes("--apply");

async function main() {
  const workspaces = await store.list("global", "workspaceRef");
  let updated = 0;
  for (const workspace of workspaces) {
    const scope = workspace.id;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(scope)) continue;
    const sources = await store.list(scope, "source");
    const autoSources = sources.filter(
      (s) => s.data.connectionId === "connection_local-auto",
    );
    if (!autoSources.length) continue;
    const autoSourceIds = new Set(autoSources.map((s) => s.id));
    const jobs = await store.list(scope, "job");
    const datasets = await store.list(scope, "dataset");
    const jobIds = jobs
      .filter((j) => j.data.sourceId && autoSourceIds.has(j.data.sourceId))
      .map((j) => j.id);
    const jobIdSet = new Set(jobIds);
    const datasetIds = datasets
      .filter(
        (d) =>
          (d.data.sourceId && autoSourceIds.has(d.data.sourceId)) ||
          (d.data.importJobId && jobIdSet.has(d.data.importJobId)),
      )
      .map((d) => d.id);
    const toExclude = [
      ...autoSourceIds,
      ...jobIds,
      ...datasetIds,
    ];
    const ws = await store.get(scope, "workspace");
    if (!ws) continue;
    const excluded = new Set<string>(
      (ws.data?.onboarding?.excludedIds || []) as string[],
    );
    const missing = toExclude.filter((id) => !excluded.has(id));
    if (!missing.length) {
      console.log(
        `workspace=${scope}: already excluded (${toExclude.length} auto items)`,
      );
      continue;
    }
    console.log(
      `${apply ? "exclude" : "would exclude"} workspace=${scope} items=${missing.length} (sources=${autoSourceIds.size}, jobs=${jobIds.length}, datasets=${datasetIds.length})`,
    );
    if (!apply) continue;
    await transaction(store, scope, async (tx) => {
      const current = await tx.get("workspace");
      if (!current) return;
      const currentExcluded = new Set<string>(
        (current.data?.onboarding?.excludedIds || []) as string[],
      );
      for (const id of missing) currentExcluded.add(id);
      tx.update(current, {
        ...current.data,
        onboarding: {
          ...(current.data.onboarding || {}),
          excludedIds: [...currentExcluded],
        },
      });
    });
    updated++;
  }
  console.log(
    `${apply ? "updated" : "dry run"}: ${updated} workspaces${apply ? "" : " (pass --apply to exclude)"}`,
  );
}

await main();
