import "../apps/api/src/config.js";
import { store, transaction } from "../apps/api/src/store.js";

// One-time: exclude the 11 orphan-only datasets (no source-linked twin).
// Dry-run default; --apply to exclude.
const apply = process.argv.includes("--apply");
async function main() {
  const scope = "ab6dbb72-5695-4cad-9a8f-38f4a6aebf51";
  const ws = await store.get(scope, "workspace");
  const excluded = new Set(((ws?.data?.onboarding?.excludedIds || []) as string[]));
  const datasets = await store.list(scope, "dataset");
  const norm = (n: string) => n.split("·").map((s) => s.trim()).join("/").replace(/\.parquet$/i, "").toLowerCase();
  const linked = new Set<string>();
  for (const d of datasets) {
    if (d.data.sampleSource || d.data.generation) continue;
    if (d.data.sourceId || d.data.importJobId) linked.add(norm(d.name || ""));
  }
  const orphans: string[] = [];
  for (const d of datasets) {
    if (d.data.sampleSource || d.data.generation) continue;
    if (d.data.sourceId || d.data.importJobId) continue;
    if (excluded.has(d.id)) continue;
    if (!linked.has(norm(d.name || ""))) orphans.push(d.id);
  }
  console.log(`${apply ? "exclude" : "would exclude"} orphan-only=${orphans.length}`);
  if (!apply || !orphans.length) return;
  await transaction(store, scope, async (tx) => {
    const current = await tx.get("workspace");
    if (!current) return;
    const cur = new Set(((current.data?.onboarding?.excludedIds || []) as string[]));
    for (const id of orphans) cur.add(id);
    tx.update(current, {
      ...current.data,
      onboarding: { ...(current.data.onboarding || {}), excludedIds: [...cur] },
    });
  });
  console.log("done");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
