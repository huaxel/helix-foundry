// Lazy records. Large workspaces publish dashboard-only (no row staging), so
// a type's record view is served as SQL over its active snapshot instead of
// materialized objects: paged, filtered, searched and sorted in the executor,
// constant memory in the API. Small staged types keep the object path; a type
// is lazy when it has no non-manual staged objects in the active generation.
//
// Navigation: the explorer writes a tiny recordRef (type + key only, never
// the row) for the rows it pages, so a logicalId deep link, an edit or a
// related reference resolves to the snapshot row without the row ever being
// staged. Manual records (created in the workspace) are real objects and join
// a lazy type's first page.
import {
  datasetTable,
  type Resource,
} from "../../../packages/shared/src/index.js";
import { queryDatasets } from "./datasets.js";
import { lit, q } from "./discovery.js";
import { effectiveObject, effectiveObjects, recordLabel } from "./context.js";
import { assert, digest } from "./security.js";
import { resource, transaction, type Store } from "./store.js";

// Nested (struct/map/list/json) columns can't be compared as values.
const NESTED = /STRUCT|MAP\(|\[\d*\]|UNION\(|^LIST|^JSON/i;
type Column = { name: string; type: string; sensitive?: boolean };

// Object types of the active generation.
export async function activeTypes(store: Store, scope: string) {
  const generation = (await store.get(scope, "workspace"))?.data.activeGeneration;
  if (!generation) return [];
  return (await store.list(scope, "objectType")).filter(
    (t) => t.data.generation === generation,
  );
}
// A type is lazy when publication skipped its rows: it has no non-manual
// staged objects in the active generation. `objects`, when given, is the
// caller's already-fetched store.list(scope, "object").
export async function lazyType(
  store: Store,
  scope: string,
  typeName: string,
  objects?: Resource[],
): Promise<Resource | undefined> {
  const generation = (await store.get(scope, "workspace"))?.data.activeGeneration;
  if (!generation) return undefined;
  const type = (await store.list(scope, "objectType")).find(
    (t) => t.data.generation === generation && t.name === typeName,
  );
  if (!type) return undefined;
  const staged = (objects ?? (await store.list(scope, "object"))).some(
    (o) =>
      o.data.generation === generation &&
      o.data.type === typeName &&
      !o.data.manual,
  );
  return staged ? undefined : type;
}
const logicalIdOf = (typeId: string, key: unknown) =>
  digest(typeId + ":" + String(key)).slice(0, 32);

// The dataset backing a type; its active snapshot is the record source.
async function typeDataset(store: Store, scope: string, type: Resource) {
  const ds = await store.get(scope, type.data.datasetId);
  return ds?.data.activeVersion ? ds : undefined;
}
// One object-shaped view over a snapshot row: the same data shape the staged
// path and effectiveObject produce (base + overlay + label).
function rowToRecord(
  scope: string,
  generation: string,
  type: Resource,
  ds: Resource,
  row: Record<string, any>,
  overlay?: Resource,
): Resource {
  const key = String(row[type.data.primaryKey]),
    logicalId = logicalIdOf(type.data.typeId, key),
    name = `${type.name} ${key}`,
    base = { ...row },
    effective = { ...base, ...(overlay?.data.values || {}) };
  return resource(scope, "object", name, {
    type: type.name,
    typeId: type.data.typeId,
    key,
    logicalId,
    generation,
    base,
    sourceVersion: ds.data.activeVersion,
    effective,
    edits: overlay?.data.values || {},
    label: recordLabel(name, type.name, effective),
    links: 0,
  }, generation + "_" + logicalId);
}
// Remember the rows a page showed so their logicalId deep links, edits and
// related references resolve later. Idempotent: only rows without a ref are
// written, and a ref is type + key only.
async function rememberRefs(
  store: Store,
  scope: string,
  items: Resource[],
) {
  if (!items.length) return;
  const have = await store.getMany(scope, items.map((i) => i.id));
  const missing = items.filter((i) => !have.has(i.id));
  if (!missing.length) return;
  await transaction(store, scope, async (tx) => {
    for (const i of missing)
      tx.put(
        resource(scope, "recordRef", i.name, {
          type: i.data.type,
          typeId: i.data.typeId,
          key: i.data.key,
          logicalId: i.data.logicalId,
          generation: i.data.generation,
        }, i.id),
      );
  });
}
export type LazyPageOpts = {
  search?: string;
  field?: string;
  value?: string;
  sort?: string;
  dir?: "asc" | "desc";
  offset: number;
  limit: number;
};
// The page + count SQL for one lazy type. The in-memory path's filter and
// search semantics are mirrored: an unknown or nested field matches nothing
// (not an error), and search covers every comparable non-sensitive column.
function lazySql(ds: Resource, type: Resource, opts: LazyPageOpts) {
  const cols: Column[] = ds.data.profile?.columns || [],
    byName = new Map(cols.map((c) => [c.name, c] as const)),
    t = q(datasetTable(ds.id));
  assert(byName.has(type.data.primaryKey), "Type primary key missing from source");
  const where: string[] = [];
  if (opts.field) {
    const c = byName.get(opts.field);
    if (!c || NESTED.test(c.type)) where.push("1 = 0");
    else where.push(`CAST(${q(c.name)} AS VARCHAR) = ${lit(String(opts.value ?? ""))}`);
  }
  const needle = (opts.search || "").trim().replace(/([%_\\])/g, "\\$1");
  if (needle) {
    const usable = cols.filter((c) => !NESTED.test(c.type) && !c.sensitive);
    where.push(
      usable.length
        ? "(" +
          usable
            .map(
              (c) =>
                `CAST(${q(c.name)} AS VARCHAR) LIKE ${lit("%" + needle + "%")} ESCAPE '\\'`,
            )
            .join(" OR ") +
          ")"
        : "1 = 0",
    );
  }
  const dir = opts.dir === "desc" ? "DESC" : "ASC";
  const sortCol =
    opts.sort && opts.sort !== "record" && opts.sort !== "links"
      ? byName.get(opts.sort)
      : undefined;
  const order =
    sortCol && !NESTED.test(sortCol.type)
      ? `ORDER BY ${q(sortCol.name)} ${dir} NULLS LAST, ${q(type.data.primaryKey)} ${dir}`
      : `ORDER BY ${q(type.data.primaryKey)} ${dir}`;
  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  return {
    // Paged in the SQL itself: the executor materializes the query's
    // result before sampling it, so only one page is ever built.
    page: `SELECT * FROM ${t}${whereSql} ${order} LIMIT ${opts.limit} OFFSET ${opts.offset}`,
    count: `SELECT count(*) AS n FROM ${t}${whereSql}`,
  };
}
// One SQL page of a lazy type's records, with the type's manual records
// merged in (first page only) and refs written for the rows shown.
export async function lazyRecordPage(
  store: Store,
  scope: string,
  type: Resource,
  objects: Resource[],
  opts: LazyPageOpts,
): Promise<{ items: Resource[]; total: number }> {
  const generation = (await store.get(scope, "workspace"))!
    .data.activeGeneration as string;
  const ds = await typeDataset(store, scope, type);
  assert(ds, "Record source unavailable", 404);
  const { page, count } = lazySql(ds, type, opts);
  const [rowsR, countR] = await Promise.all([
    // No job offset: the SQL already paged; the job limit only sizes the
    // sample read of the (single-page) result table.
    queryDatasets(store, scope, [ds.id], page, { limit: opts.limit }),
    queryDatasets(store, scope, [ds.id], count),
  ]);
  const total = Number(countR.rows[0]?.n ?? 0),
    manual = objects.filter(
      (o) =>
        o.data.generation === generation &&
        o.data.type === type.name &&
        o.data.manual,
    );
  // A manual record shadows the snapshot row with the same key.
  const manualIds = new Set(manual.map((o) => o.id)),
    rows = (rowsR.rows as Record<string, any>[]).filter(
      (r) => !manualIds.has(generation + "_" + logicalIdOf(type.data.typeId, r[type.data.primaryKey])),
    ),
    overlays = await store.getMany(
      scope,
      rows.map((r) => "overlay_" + logicalIdOf(type.data.typeId, r[type.data.primaryKey])),
    );
  let items = rows.map((r) =>
    rowToRecord(
      scope,
      generation,
      type,
      ds,
      r,
      overlays.get("overlay_" + logicalIdOf(type.data.typeId, r[type.data.primaryKey])),
    ),
  );
  // Manual records are few and live in the workspace: they are filtered in
  // memory (same semantics as the staged path) and join the first page.
  let matchedManual = manual;
  if (opts.search) {
    const s = String(opts.search).toLowerCase();
    matchedManual = matchedManual.filter((o) =>
      JSON.stringify([o.name, o.description, o.data.effective || o.data.base])
        .toLowerCase()
        .includes(s),
    );
  }
  if (opts.field && opts.value !== undefined)
    matchedManual = matchedManual.filter(
      (o) =>
        Object.hasOwn(o.data.effective, String(opts.field)) &&
        String(o.data.effective[String(opts.field)]) === String(opts.value),
    );
  if (opts.offset === 0 && matchedManual.length) {
    const links = new Map<string, number>();
    for (const r of await store.list(scope, "relation"))
      if (r.data.generation === generation)
        for (const end of [r.data.from, r.data.to])
          links.set(end, (links.get(end) || 0) + 1);
    const merged = (await effectiveObjects(store, scope, matchedManual)).map(
      (o: any) => ({
        ...o,
        data: {
          ...o.data,
          label: recordLabel(o.name, o.data.type, o.data.effective),
          links: links.get(o.id) || 0,
        },
      }),
    );
    items = [...merged, ...items].slice(0, opts.limit);
  }
  await rememberRefs(store, scope, items);
  // Manual records all join the first page, but the total counts every match
  // on every page — otherwise the paginator total shrinks after page one.
  return { items, total: total + matchedManual.length };
}
// One lazy record by key, with its overlay applied (detail and edit paths).
export async function lazyRecord(
  store: Store,
  scope: string,
  type: Resource,
  key: unknown,
): Promise<Resource | undefined> {
  const generation = (await store.get(scope, "workspace"))?.data.activeGeneration;
  if (!generation) return undefined;
  const ds = await typeDataset(store, scope, type);
  if (!ds) return undefined;
  // No catch-all here: a missing row returns undefined (callers 404), but
  // executor or store failures must propagate as 5xx, not masquerade as
  // "Record unavailable".
  const r = await queryDatasets(
    store,
    scope,
    [ds.id],
    `SELECT * FROM ${q(datasetTable(ds.id))} WHERE CAST(${q(type.data.primaryKey)} AS VARCHAR) = ${lit(String(key))} LIMIT 1`,
  );
  const row = r.rows[0] as Record<string, any> | undefined;
  if (!row) return undefined;
  const rec = rowToRecord(
    scope,
    generation,
    type,
    ds,
    row,
    await store.get(scope, "overlay_" + logicalIdOf(type.data.typeId, key)),
  );
  await rememberRefs(store, scope, [rec]);
  return rec;
}
// The record view behind an id in the active generation: a staged object
// (with its overlay), or — for lazy types — the snapshot row behind a
// recordRef. The returned view is not stored; it carries base/effective/
// edits like effectiveObject's output.
export async function objectView(
  store: Store,
  scope: string,
  id: string,
): Promise<Resource | undefined> {
  const r = await store.get(scope, id);
  if (r?.kind === "object") return effectiveObject(store, scope, r);
  if (r?.kind === "recordRef") {
    const type = (await activeTypes(store, scope)).find(
      (t) => t.name === r.data.type,
    );
    return type ? lazyRecord(store, scope, type, r.data.key) : undefined;
  }
  return undefined;
}
