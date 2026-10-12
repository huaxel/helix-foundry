import {
  type Resource,
  type SuggestedEntity,
} from "../../../../packages/shared/src/index.js";
import { entityName, slug, tableName } from "./names.js";

export function entityColumns(
  entity: Pick<SuggestedEntity, "anchorDatasetId" | "members">,
  datasets: Map<string, Resource>,
) {
  const prefixes = new Map<string, string>(),
    taken = new Set<string>();
  for (const m of entity.members) {
    if (m.datasetId === entity.anchorDatasetId) continue;
    const table = slug(entityName(tableName(m.datasetName, m.source)));
    let p = m.source === "upload" ? table : slug(m.source);
    if (taken.has(p)) p = `${slug(m.source)}_${table}`;
    for (let n = 2, base = p; taken.has(p); n++) p = `${base}_${n}`;
    taken.add(p);
    prefixes.set(m.datasetId, p);
  }
  const used = new Set<string>(),
    out: { datasetId: string; column: string; as: string; type: string }[] = [];
  const ordered = [
    ...entity.members.filter((m) => m.datasetId === entity.anchorDatasetId),
    ...entity.members.filter((m) => m.datasetId !== entity.anchorDatasetId),
  ];
  for (const m of ordered)
    for (const c of datasets.get(m.datasetId)?.data.profile?.columns || []) {
      if (m.via && c.name === m.via.column) continue;
      const as = prefixes.has(m.datasetId)
        ? `${prefixes.get(m.datasetId)}_${c.name}`
        : c.name;
      if (used.has(as.toLowerCase())) continue;
      used.add(as.toLowerCase());
      out.push({ datasetId: m.datasetId, column: c.name, as, type: c.type });
    }
  return out;
}
// The entity output column holding a dataset column's values, following join keys
// to the dataset they were merged on.
export function entityColumn(
  entity: Pick<SuggestedEntity, "anchorDatasetId" | "members">,
  datasets: Map<string, Resource>,
  datasetId: string,
  column: string,
  depth = 0,
): string | undefined {
  const m = entity.members.find((x) => x.datasetId === datasetId);
  if (!m || depth > entity.members.length) return undefined;
  if (m.via && m.via.column === column)
    return entityColumn(
      entity,
      datasets,
      m.via.targetDatasetId,
      m.via.targetColumn,
      depth + 1,
    );
  return entityColumns(entity, datasets).find(
    (c) => c.datasetId === datasetId && c.column === column,
  )?.as;
}

// Applies the user's review: drops excluded entities (and their links) and renames.
