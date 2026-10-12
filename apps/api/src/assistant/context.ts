import type { Resource } from "../../../../packages/shared/src/index.js";
import type { Store } from "../store.js";
import { assert } from "../security.js";
import { pipelineId } from "../datasets.js";

const FOCUS_STOP = new Set(
  "which,what,when,where,does,have,most,each,per,our,from,with,that,this,these,those,show,list,find,many,much,between,over,under,into,onto".split(","),
);
const nameTokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !FOCUS_STOP.has(t));
// Rank datasets by token overlap with a question so analysis fits the local
// model's window: table-name hits weigh most, then column hits, then size.
// Published anchors always survive so questions about the live workspace
// keep their datasets.
export function focusDatasets(
  datasets: Resource[],
  goal: string,
  limit = 25,
  extraIds: string[] = [],
) {
  const qt = new Set(nameTokens(goal));
  const scored = datasets.map((d) => {
    const table = new Set(
      nameTokens(d.name.replace(/\.(parquet|csv|json)$/i, "")),
    );
    let score = 0;
    for (const t of qt) if (table.has(t)) score += 3;
    for (const c of d.data.profile?.columns || []) {
      const ct = new Set(nameTokens(c.name));
      for (const t of qt)
        if (ct.has(t)) {
          score += 1;
          break;
        }
    }
    return { d, score };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.d.data.profile?.rows || 0) - (a.d.data.profile?.rows || 0),
  );
  const extra = new Set(extraIds),
    out: Resource[] = [];
  for (const d of datasets)
    if (extra.has(d.id) && out.length < limit) out.push(d);
  for (const { d } of scored)
    if (out.length >= limit) break;
    else if (!out.includes(d)) out.push(d);
  return out;
}
// A resource an Analyst question may be scoped to (active generation only).
export async function assistantResource(
  store: Store,
  scope: string,
  id: string,
) {
  const r = await store.get(scope, id);
  assert(
    r && ["dataset", "dashboard", "object", "run", "proposal"].includes(r.kind),
    "Context resource unavailable",
    404,
  );
  if (r.data.generation)
    assert(
      r.data.generation ===
        (await store.get(scope, "workspace"))?.data.activeGeneration,
      "Context resource unavailable",
      404,
    );
  return r;
}
export { pipelineId };
export function threadOf(run: Resource, runs?: Map<string, Resource>): string {
  if (run.data.threadId) return run.data.threadId;
  const previous = runs?.get(run.data.context?.resourceId);
  return previous && !previous.data.task ? threadOf(previous, runs) : run.id;
}
