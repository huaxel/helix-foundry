import {
  type ColumnProfile,
  type Resource,
  type SuggestedEntity,
  type SuggestedLink,
} from "../../../../packages/shared/src/index.js";
import {
  cmp,
  singular,
  words,
} from "./names.js";

export type Info = {
  d: Resource;
  index: number;
  table: string;
  source: string;
  system: string;
  columns: ColumnProfile[];
  rows: number;
  key?: string;
  alt: Set<string>;
};
export type Col = {
  i: number;
  ds: Info;
  name: string;
  column: string;
  field?: string;
  integer: boolean;
  unique: boolean;
  key: boolean;
};
export type Edge = {
  A: Col;
  B: Col;
  identity: boolean;
  extension: boolean;
  declared: boolean;
  evidence: SuggestedLink["evidence"];
  exact: number;
  matched: number;
  total: number;
  caseRows: number;
};
export type Draft = {
  members: SuggestedEntity["members"];
  anchor: Info;
  key: string;
  kind: SuggestedEntity["kind"];
  degree: number;
  name: string;
  id: string;
  namedBy?: SuggestedEntity["namedBy"];
};
export const keyType = (t: string) =>
  /^(VARCHAR|UUID|U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?)$/.test(t);
// Names are compared as words, so "Customer ID", customer-id and customerId all
// read as customer_id. Natural keys (sku, order_number, handle) count as keys too.
export const idWords = new Set(["id", "uuid", "guid"]);
export const keyWords = new Set(
  "id uuid guid key code number no num sku slug handle username".split(" "),
);
export const email = (n: string) => /e-?mail/i.test(n);
export const keyName = (n: string) => keyWords.has(words(n).at(-1) || "") || email(n);
export const idName = (n: string) => idWords.has(words(n).at(-1) || "");
export const nested = (t: string) => /STRUCT|MAP\(|\[\]|UNION\(|^LIST/i.test(t);
// The noun a key column refers to: ticket_id -> ticket; a bare id or sku -> its table.
export const stem = (c: { name: string; ds: Info }) => {
  const ws = words(c.name);
  return singular(
    (ws.length < 2 ? words(c.ds.table) : ws.slice(0, -1)).at(-1) || "",
  );
};
// Integer keys only pair with keys for the same noun; a shortened noun (org_id for
// organizations) still counts. The overlap query joins on the first letters.
export const sameStem = (a: string, b: string) =>
  a === b ||
  (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));
export const noun = (s: string) => singular(words(s).at(-1) || "");

// A dataset's own key: a unique non-null column named for the table (ticket_id in
// support_tickets). The profile flag alone also marks names and timestamps, so any
// other unique column is only a last resort.
export function ownKey(x: Info) {
  const unique = x.columns.filter((c) => c.primaryKey && keyType(c.type));
  const nouns = words(x.table).map(singular);
  return (
    unique.find(
      (c) =>
        words(c.name).join("_") === "id" ||
        (idName(c.name) && nouns.includes(stem({ name: c.name, ds: x }))),
    ) ??
    unique.find((c) => idName(c.name)) ??
    unique.find((c) => keyName(c.name) && !email(c.name)) ??
    unique.find((c) => !/INT/.test(c.type) && !email(c.name)) ??
    unique.find((c) => /INT/.test(c.type))
  )?.name;
}
export function declaredKeys(infos: Info[], sources: Map<string, Resource>) {
  const byTable = new Map<string, Info>();
  for (const x of infos) {
    const s = x.d.data.sourceId && sources.get(x.d.data.sourceId);
    if (s) byTable.set(x.system + "\u0000" + s.name.toLowerCase(), x);
  }
  const find = (system: string, table?: string) =>
    table
      ? (byTable.get(system + "\u0000" + table.toLowerCase()) ??
        [...byTable.entries()].find(
          ([k]) =>
            k.startsWith(system + "\u0000") &&
            k.endsWith("." + table.toLowerCase()),
        )?.[1])
      : undefined;
  const out = new Map<string, [Info, string, Info, string]>();
  for (const x of infos) {
    const s = x.d.data.sourceId && sources.get(x.d.data.sourceId);
    const found = s?.data.discovery;
    if (!found) continue;
    for (const k of [...(found.foreignKeys || []), ...(found.keys || [])]) {
      const from = find(x.system, k.tableName ?? k.table_name),
        to = find(x.system, k.referencedTable ?? k.referenced_table),
        fromColumn = k.columnName ?? k.column_name,
        toColumn = k.referencedColumn ?? k.referenced_column;
      if (from && to && from !== to && fromColumn && toColumn)
        out.set([from.d.id, fromColumn, to.d.id, toColumn].join("\u0000"), [
          from,
          fromColumn,
          to,
          toColumn,
        ]);
    }
  }
  return [...out.values()];
}
// Normalized schema signature: singularized word-joined column names. Metadata-only;
// two exports of one table share a signature even when their rows are disjoint.
export const schemaSig = (x: Info) =>
  new Set(x.columns.map((c) => words(c.name).map(singular).join("_")));
// A key-named, near-unique column stands in as a provisional anchor key so a group
// without a proven unique key is still placed instead of dropped. It never drives
// links; value overlap alone does that.
export function provisionalKey(x: Info) {
  const ratio = (c: (typeof x.columns)[number]) =>
    c.distinct / Math.max(1, x.rows - c.nulls);
  const cands = x.columns.filter(
    (c) =>
      keyType(c.type) && keyName(c.name) && c.distinct >= 2 && ratio(c) >= 0.75,
  );
  cands.sort(
    (a, b) =>
      ratio(b) - ratio(a) ||
      Number(idName(b.name)) - Number(idName(a.name)) ||
      cmp(a.name, b.name),
  );
  return cands[0]?.name;
}
export function structFields(type: string) {
  const m = /^STRUCT\((.*)\)$/.exec(type);
  if (!m) return [];
  const parts: string[] = [];
  let depth = 0,
    quoted = false,
    current = "";
  for (const ch of m[1]) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && !depth && ch === ",") {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return parts.flatMap((p) => {
    const f = /^("(?:[^"]|"")+"|\S+)\s+(.+)$/.exec(p);
    if (!f || f[2] !== "VARCHAR") return [];
    return [f[1].replace(/^"|"$/g, "").replaceAll('""', '"')];
  });
}

