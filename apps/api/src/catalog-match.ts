import type { Catalog, CatalogTable } from "../../../packages/shared/src/index.js";

// Matching between catalog tables (SAP/logical names like ZST_PERSON or
// TAX_GENERAL.DFMCA_RETURN) and Helix datasets (paths like
// stg_pers/ZST_PERSON.parquet). Case/path/extension/domain-insensitive; a
// catalog never needs to know Helix file layout.
export function normTable(name: string): string {
  const base = name
    .split(/[/\\]/)
    .at(-1)!
    .replace(/\.(parquet|csv|json|qvd)(\.keys|\.qvdhash)?$/i, "");
  const logical = base.includes(".") ? base.split(".").at(-1)! : base;
  return logical.toUpperCase();
}
// A physical column for a catalog (SAP) key: exact match first, else a column
// whose name ends with the key (FrenchLabel_GPART resolves GPART). Returns the
// physical column name or undefined when the key is absent.
export function resolveColumn(
  columns: { name: string }[],
  key: string,
): string | undefined {
  const want = key.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!want) return undefined;
  const norm = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const exact = columns.find((c) => norm(c.name) === want);
  if (exact) return exact.name;
  const suffix = columns.find(
    (c) => norm(c.name).endsWith(want) && norm(c.name).length > want.length,
  );
  return suffix?.name;
}
export function indexCatalog(catalog: Catalog): Map<string, CatalogTable> {
  const map = new Map<string, CatalogTable>();
  for (const t of catalog.tables) {
    const n = normTable(t.table);
    if (!map.has(n)) map.set(n, t);
  }
  return map;
}
