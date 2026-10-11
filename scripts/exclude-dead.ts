import "../apps/api/src/config.js";
import { store, transaction } from "../apps/api/src/store.js";

// One-time: exclude permanently-empty datasets (no records and no live import)
// on Atom so 25 dead files stop gating the full root. Dry-run default.
const apply = process.argv.includes("--apply");
async function main() {
  const scope = "ab6dbb72-5695-4cad-9a8f-38f4a6aebf51";
  const ws = await store.get(scope, "workspace");
  const excluded = new Set(((ws?.data?.onboarding?.excludedIds || []) as string[]));
  const datasets = await store.list(scope, "dataset");
  const jobs = await store.list(scope, "job");
  const jobBySource = new Map<string, any>();
  const jobById = new Map<string, any>();
  for (const j of jobs) {
    jobById.set(j.id, j);
    if (j.data.sourceId) jobBySource.set(j.data.sourceId as string, j);
  }
  const dead: { id: string; name: string; why: string }[] = [];
  for (const d of datasets) {
    if (excluded.has(d.id)) continue;
    const rows = d.data.activeVersion?.rows ?? d.data.profile?.rows;
    if (rows && rows > 0) continue;
    if (d.data.activeVersion && (d.data.profile?.rows ?? 0) === 0) {
      dead.push({ id: d.id, name: d.name, why: "0-row file" });
      continue;
    }
    // No active version: only dead if no live import will produce one.
    const job = (d.data.importJobId && jobById.get(d.data.importJobId)) || (d.data.sourceId && jobBySource.get(d.data.sourceId as string));
    const status = job?.data.status;
    if (!job) dead.push({ id: d.id, name: d.name, why: "no job" });
    else if (status === "failed" || status === "canceled") dead.push({ id: d.id, name: d.name, why: `job ${status}` });
    // queued/running/succeeded-with-rows handled above; succeeded-no-rows falls below.
    else if (status === "succeeded") dead.push({ id: d.id, name: d.name, why: "job succeeded but no records" });
  }
  console.log(`${apply ? "exclude" : "would exclude"} dead=${dead.length}`);
  for (const x of dead.slice(0, 30)) console.log(`  ${x.why}: ${x.name}`);
  if (!apply || !dead.length) return;
  await transaction(store, scope, async (tx) => {
    const current = await tx.get("workspace");
    if (!current) return;
    const cur = new Set(((current.data?.onboarding?.excludedIds || []) as string[]));
    for (const x of dead) cur.add(x.id);
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
