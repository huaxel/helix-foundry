import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execute as localExecute } from "../services/executor/src/engine.js";
import { vi } from "vitest";
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => localExecute(job),
}));
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows } from "../apps/api/src/datasets.js";
import { onboardingState } from "../apps/api/src/onboarding-state.js";
import { suggestOntology } from "../apps/api/src/discovery.js";
import {
  derivedBusinessName,
  normTable,
  resolveColumn,
  unionTableColumns,
} from "../apps/api/src/catalog-match.js";
import { createApp } from "../apps/api/src/app.js";
import { config } from "../apps/api/src/config.js";

const store = new MemoryStore();
const scopes: string[] = [];
let n = 0;
const workspace = (s: string) =>
  transaction(store, s, async (tx) =>
    tx.put(resource(s, "workspace", "Catalog", {}, "workspace")),
  );
const catalog = {
  version: 1 as const,
  name: "Test catalog",
  tables: [
    {
      table: "CUST",
      businessName: "Customer",
      definition: "A customer record.",
      keys: [["CUST_ID"]],
    },
    {
      table: "ORD",
      businessName: "Order",
      definition: "A customer order.",
      keys: [["ORD_ID"]],
    },
    {
      table: "NOTELESS",
      businessName: "Note",
      definition: "A free-text note.",
      keys: [["body"]],
    },
  ],
  joins: [
    {
      leftTable: "ORD",
      leftKey: "CUST_ID",
      rightTable: "CUST",
      rightKey: "CUST_ID",
      cardinality: "N:1",
      note: "Order to customer.",
    },
  ],
  domains: [],
};
async function suggestWithCatalog(withCatalog: boolean) {
  const s = `catalog_${Date.now()}_${n++}`;
  scopes.push(s);
  await workspace(s);
  await ingestRows(store, s, "CUST", [
    { CUST_ID: "C1", NAME: "Ann" },
    { CUST_ID: "C2", NAME: "Bo" },
    { CUST_ID: "C3", NAME: "Cy" },
  ]);
  // Only half the orders resolve, so statistics miss the join (<80%/90%)
  // while the curated catalog still asserts it.
  await ingestRows(store, s, "ORD", [
    { ORD_ID: "O1", CUST_ID: "C1" },
    { ORD_ID: "O2", CUST_ID: "C2" },
    { ORD_ID: "O3", CUST_ID: "CX" },
    { ORD_ID: "O4", CUST_ID: "CY" },
  ]);
  // No unique, non-key-named columns: unplaced without a catalog key.
  await ingestRows(store, s, "NOTELESS", [
    { body: "hello", tag: "a" },
    { body: "hello", tag: "b" },
    { body: "world", tag: "a" },
  ]);
  if (withCatalog)
    await transaction(store, s, async (tx) =>
      tx.put(resource(s, "catalog", "Test catalog", catalog, "catalog")),
    );
  const state = await onboardingState(store, s);
  return suggestOntology(store, s, {
    datasets: state.datasets,
    sources: state.sources,
    signature: state.signature,
  });
}
afterAll(async () => {
  for (const s of scopes)
    for (const d of ["incoming", "datasets"])
      await rm(resolve(config.dataDir, d, s), { recursive: true, force: true });
});

it("names entities from catalog business terms and links curated joins", async () => {
  const suggestion = await suggestWithCatalog(true);
  expect(suggestion.entities.map((e) => e.name).sort()).toEqual([
    "Customer",
    "Note",
    "Order",
  ]);
  const curated = suggestion.links.filter((l) =>
    l.id.startsWith("catalog-"),
  );
  expect(curated).toHaveLength(1);
  expect(curated[0]).toMatchObject({
    fromColumn: "CUST_ID",
    toColumn: "CUST_ID",
    evidence: "declared",
    name: "references",
  });
  const order = suggestion.entities.find((e) => e.name === "Order")!;
  const customer = suggestion.entities.find((e) => e.name === "Customer")!;
  expect(curated[0].from).toBe(order.id);
  expect(curated[0].to).toBe(customer.id);
  // The keyless table is placed via its asserted key, not dropped.
  expect(suggestion.unplaced).toEqual([]);
});

it("falls back to statistical discovery without a catalog", async () => {
  const suggestion = await suggestWithCatalog(false);
  // Raw slugs, no curated links, and the keyless table stays unplaced.
  expect(
    suggestion.entities.some((e) => ["Customer", "Order", "Note"].includes(e.name)),
  ).toBe(false);
  expect(suggestion.links.filter((l) => l.id.startsWith("catalog-"))).toEqual(
    [],
  );
  expect(suggestion.unplaced.length).toBeGreaterThan(0);
});

it("resolves exact, suffix, and label-qualified key columns", () => {
  const cols = [
    { name: "PARTNER" },
    { name: "Partenaire_GPART" },
    { name: "Taxpayer.return_z019" },
  ];
  expect(resolveColumn(cols, "PARTNER")).toBe("PARTNER");
  expect(resolveColumn(cols, "GPART")).toBe("Partenaire_GPART");
  expect(resolveColumn(cols, "TAXPAYER")).toBe("Taxpayer.return_z019");
  expect(resolveColumn(cols, "FBNUM")).toBeUndefined();
  expect(normTable("stg_pers/ZST_PERSON.parquet")).toBe("ZST_PERSON");
  expect(normTable("TAX_GENERAL.DFMCA_RETURN")).toBe("DFMCA_RETURN");
});

it("derives business names only from strict definition patterns", () => {
  const t = (definition?: string, businessName?: string) =>
    derivedBusinessName({ table: "X", definition, businessName } as any);
  expect(t("Reference table: Conflict type")).toBe("Conflict type");
  expect(t("Code table: Address type")).toBe("Address type");
  expect(t("Code: status codes")).toBe("Status codes");
  expect(t("Universal journal entry")).toBe("");
  expect(t("Reference table: Conflict type (legacy)")).toBe("");
  expect(t("")).toBe("");
  expect(t("Code table: Address type", "Addresses")).toBe("Addresses");
});

it("unions columns across same-name extract variants", () => {
  const unioned = unionTableColumns([
    { name: "loader/zrole.parquet", data: { profile: { columns: [{ name: "RoleId" }] } } },
    { name: "tax_general/zrole.parquet", data: { profile: { columns: [{ name: "ZZ_ROLE_ID" }] } } },
    { name: "other.parquet", data: {} },
  ] as any);
  expect(unioned.get("ZROLE")!.map((c) => c.name).sort()).toEqual([
    "RoleId",
    "ZZ_ROLE_ID",
  ]);
  expect(resolveColumn(unioned.get("ZROLE")!, "ZZ_ROLE_ID")).toBe(
    "ZZ_ROLE_ID",
  );
});

// General import route: any catalog in this format, replaceable, validated.
let app: Awaited<ReturnType<typeof createApp>>,
  appStore: MemoryStore,
  scope = "",
  other = "";
const request = (method: any, path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1/workspaces/${scope}` + path,
    payload: payload as any,
  });
beforeEach(async () => {
  appStore = new MemoryStore();
  app = await createApp(appStore);
  await app.ready();
  const r = await app.inject({ method: "GET", url: "/api/v1/me" });
  expect(r.statusCode).toBe(200);
  scope = r.json().workspaces[0].id;
  other = r.json().workspaces[1]?.id || scope;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

it("imports, fetches and replaces a general catalog", async () => {
  const bad = await request("POST", "/catalog/import", {
    catalog: { version: 2, tables: [], joins: [] },
  });
  expect(bad.statusCode).toBe(400);
  const first = await request("POST", "/catalog/import", { catalog });
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json()).toEqual({ tables: 3, joins: 1, domains: 0 });
  const fetched = await request("GET", "/catalog", undefined);
  expect(fetched.json()).toMatchObject({ name: "Test catalog", version: 1 });
  expect(fetched.json().tables).toHaveLength(3);
  const again = await request("POST", "/catalog/import", {
    catalog: { ...catalog, tables: catalog.tables.slice(0, 1) },
  });
  expect(again.json()).toEqual({ tables: 1, joins: 1, domains: 0 });
  expect((await request("GET", "/catalog", undefined)).json().tables).toHaveLength(1);
  // Workspaces are isolated: the other workspace has no catalog.
  if (other !== scope) {
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other}/catalog`,
    });
    expect(r.json()).toBeNull();
  }
});
