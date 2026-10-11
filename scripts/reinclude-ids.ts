import "../apps/api/src/config.js";
import { store, transaction } from "../apps/api/src/store.js";

// One-time repair: re-include specific datasets (+source/job) by ID.
const ids = (process.env.INCLUDE_IDS || "").split(",").filter(Boolean);
const apply = process.argv.includes("--apply");
async function main() {
  const scope = "5a32a899-b362-47d9-80e1-c679d2ead111";
  const ws = await store.get(scope, "workspace");
  const excluded = new Set(((ws?.data?.onboarding?.excludedIds || []) as string[]));
  const toRemove = new Set<string>();
  for (const id of ids) {
    const d = await store.get(scope, id);
    if (!d) {
      console.log(`not found: ${id}`);
      continue;
    }
    console.log(`found: ${d.name} active=${!!d.data.activeVersion}`);
    toRemove.add(id);
    if (d.data.sourceId) toRemove.add(d.data.sourceId as string);
    if (d.data.importJobId) toRemove.add(d.data.importJobId as string);
  }
  const missing = [...toRemove].filter((id) => excluded.has(id));
  console.log(`${apply ? "re-include" : "would re-include"} ids=${missing.length}`);
  if (!apply || !missing.length) return;
  await transaction(store, scope, async (tx) => {
    const current = await tx.get("workspace");
    if (!current) return;
    const cur = new Set(((current.data?.onboarding?.excludedIds || []) as string[]));
    for (const id of missing) cur.delete(id);
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
