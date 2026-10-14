import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execute as localExecute } from "../services/executor/src/engine.js";
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => localExecute(job),
}));
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows } from "../apps/api/src/datasets.js";
import { saveProposal, publishProposal } from "../apps/api/src/assistant.js";
import { digest } from "../apps/api/src/security.js";
import { BundleSchema, datasetTable } from "../packages/shared/src/index.js";
import { config } from "../apps/api/src/config.js";

let store: MemoryStore,
  app: Awaited<ReturnType<typeof createApp>>,
  scope: string;
const request = (method: any, path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1/workspaces/${scope}` + path,
    payload: payload as any,
  });

const NAMES = [
  "Avery Stone",
  "Bianca Moore",
  "Caleb Reed",
  "Dana Wells",
  "Eli Ford",
  "Faye Kim",
  "Gus Lane",
  "Hana Ito",
  "Ivan Petrov",
  "Jade Cruz",
  "Kai Novak",
  "Lena Vogel",
  "Milo Grant",
  "Nadia Rahman",
  "Otis Bell",
  "Priya Nair",
  "Quinn Hale",
  "Rosa Diaz",
  "Sam Okafor",
  "Tara Lind",
  "Uma Patel",
  "Viktor Ash",
  "Wren Blake",
];
const REGIONS = ["EU", "NA", "APAC"];
const ROWS = NAMES.map((name, i) => ({
  id: "C" + String(i + 1).padStart(3, "0"),
  name,
  region: REGIONS[i % 3],
  amount: 100 * (23 - i),
}));
const TYPE_ID = digest("Customer").slice(0, 20);
const logicalId = (key: string) => digest(TYPE_ID + ":" + key).slice(0, 32);

beforeEach(async () => {
  store = new MemoryStore();
  app = await createApp(store);
  await app.ready();
  const r = await app.inject({ method: "GET", url: "/api/v1/me" });
  scope = r.json().workspaces[0].id;
});
afterEach(async () => {
  await app.close();
  for (const d of ["incoming", "datasets"])
    await rm(resolve(config.dataDir, d, scope), {
      recursive: true,
      force: true,
    });
});

// Publishes the customer ontology with stageRecords off (the large-workspace
// path: no staged rows, no staged relations) or on (the classic path).
async function publish(stageRecords: boolean) {
  const ds = await ingestRows(
    store,
    scope,
    "Customers",
    ROWS,
    undefined,
    "customers",
  );
  await transaction(store, "global", async (tx) =>
    tx.put(
      resource(
        "global",
        "member",
        "Editor",
        { role: "editor" },
        `actor:${scope}`,
      ),
    ),
  );
  const bundle = BundleSchema.parse({
    summary: "Customer workspace",
    assumptions: ["A customer is one row."],
    catalog: [],
    pipelines: [],
    ontology: [
      {
        name: "Customer",
        datasetId: ds.id,
        primaryKey: "id",
        properties: ["id", "name", "region", "amount"],
      },
    ],
    relationships: [],
    dashboards: [
      {
        name: "Overview",
        widgets: [
          {
            title: "Customers",
            type: "metric",
            inputs: [ds.id],
            sql: `SELECT count(*) AS n FROM ${datasetTable(ds.id)}`,
          },
        ],
      },
    ],
    actions: [],
  });
  const p = await saveProposal(store, scope, bundle);
  await publishProposal(store, scope, p.id, p.data.hash, "actor", "ok", {
    stageRecords,
  });
  expect((await store.list(scope, "object")).length).toBe(
    stageRecords ? ROWS.length : 0,
  );
  return ds;
}
const page = (qs: string) =>
  request("GET", `/resources/object?${qs}`);

describe("lazy records (un-staged types)", () => {
  it("pages, filters, searches and sorts the snapshot via SQL", async () => {
    await publish(false);
    // Page one: ten rows in key order, with the object view shape.
    const first = await page("type=Customer&limit=10&offset=0");
    expect(first.statusCode, first.body).toBe(200);
    const f = first.json();
    expect(f.total).toBe(ROWS.length);
    expect(f.items).toHaveLength(10);
    expect(f.items.map((r: any) => r.data.key)).toEqual(
      ROWS.slice(0, 10).map((r) => r.id),
    );
    const generation = (await store.get(scope, "workspace"))!
      .data.activeGeneration;
    const row = f.items[0];
    expect(row.kind).toBe("object");
    expect(row.id).toBe(generation + "_" + logicalId("C001"));
    expect(row.data).toMatchObject({
      type: "Customer",
      key: "C001",
      logicalId: logicalId("C001"),
      links: 0,
    });
    expect(row.data.label).toBe("Avery Stone");
    // The snapshot returns BIGINT as strings; compare numerically.
    expect(row.data.effective).toMatchObject({
      id: "C001",
      name: "Avery Stone",
      region: "EU",
    });
    expect(Number(row.data.effective.amount)).toBe(2300);
    expect(row.data.sourceVersion).toBeTruthy();
    // Page two and three: the rest, no overlap.
    const second = (await page("type=Customer&limit=10&offset=10")).json();
    const third = (await page("type=Customer&limit=10&offset=20")).json();
    expect(second.items.map((r: any) => r.data.key)).toEqual(
      ROWS.slice(10, 20).map((r) => r.id),
    );
    expect(third.items.map((r: any) => r.data.key)).toEqual(
      ROWS.slice(20).map((r) => r.id),
    );
    // Field filter and search mirror the staged path's semantics.
    const eu = (await page("type=Customer&field=region&value=EU")).json();
    expect(eu.total).toBe(ROWS.filter((r) => r.region === "EU").length);
    expect(eu.items.every((r: any) => r.data.effective.region === "EU")).toBe(
      true,
    );
    expect((await page("type=Customer&field=nope&value=x")).json().total).toBe(
      0,
    );
    const kai = (await page("type=Customer&search=Kai")).json();
    expect(kai.total).toBe(1);
    expect(kai.items[0].data.key).toBe("C011");
    const apac = (await page("type=Customer&search=APAC")).json();
    expect(apac.total).toBe(ROWS.filter((r) => r.region === "APAC").length);
    // Sorts run in SQL: a field descending, blanks/nulls last, then by key.
    const desc = (
      await page("type=Customer&sort=amount&dir=desc&limit=500")
    ).json();
    const amounts = desc.items.map((r: any) => r.data.effective.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    expect(Number(amounts[0])).toBe(2300);
    // No staged rows were created by browsing.
    expect((await store.list(scope, "object")).length).toBe(0);
    // But the rows this workspace paged have refs (type + key only).
    const refs = await store.getMany(
      scope,
      ROWS.slice(0, 10).map((r) => generation + "_" + logicalId(r.id)),
    );
    expect(refs.size).toBe(10);
    expect(refs.get(generation + "_" + logicalId("C001"))).toMatchObject({
      kind: "recordRef",
      data: { type: "Customer", key: "C001", logicalId: logicalId("C001") },
    });
  });

  it("resolves a paged record by logicalId and shows no staging artifacts", async () => {
    await publish(false);
    await page("type=Customer&limit=10&offset=0");
    const r = await request("GET", `/records/${logicalId("C005")}`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.record.data).toMatchObject({
      type: "Customer",
      key: "C005",
      logicalId: logicalId("C005"),
    });
    expect(body.record.data.effective).toMatchObject({
      id: "C005",
      name: "Eli Ford",
      region: "NA",
    });
    expect(Number(body.record.data.effective.amount)).toBe(1900);
    expect(body.related).toEqual([]);
    expect(body.history).toEqual([]);
    // The generic resource route resolves the same ref.
    const generation = (await store.get(scope, "workspace"))!
      .data.activeGeneration;
    const byId = await request(
      "GET",
      `/resources/object/${generation}_${logicalId("C005")}`,
    );
    expect(byId.statusCode).toBe(200);
    expect(byId.json().data.key).toBe("C005");
    // A row that was never paged has no ref and stays unavailable.
    const unknown = await request("GET", `/records/${logicalId("C021")}`);
    expect(unknown.statusCode).toBe(404);
  });

  it("supports edits on lazy records through the normal overlay flow", async () => {
    await publish(false);
    await page("type=Customer&limit=10&offset=0");
    const generation = (await store.get(scope, "workspace"))!
      .data.activeGeneration,
      objectId = `${generation}_${logicalId("C001")}`;
    const preview = await request("POST", "/actions/preview", {
      objectId,
      values: { region: "LATAM" },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      before: { region: "EU" },
      after: { region: "LATAM" },
      revision: 0,
    });
    const executed = await request("POST", "/actions/execute", {
      objectId,
      values: { region: "LATAM" },
      revision: 0,
      idempotencyKey: randomUUID(),
    });
    expect(executed.statusCode, executed.body).toBe(200);
    // The list and the detail both show the effective value with the edit.
    const listed = (
      await page("type=Customer&limit=10&offset=0")
    ).json().items.find((r: any) => r.data.key === "C001");
    expect(listed.data.effective.region).toBe("LATAM");
    expect(listed.data.edits).toEqual({ region: "LATAM" });
    const detail = (
      await request("GET", `/records/${logicalId("C001")}`)
    ).json();
    expect(detail.record.data.effective.region).toBe("LATAM");
    expect(detail.record.data.base.region).toBe("EU");
    expect(detail.history.length).toBe(1);
  });

  it("keeps manual records visible and blocks duplicate snapshot keys", async () => {
    await publish(false);
    await page("type=Customer&limit=10&offset=0");
    // A key that is in the snapshot and has been paged (ref exists) is
    // blocked, exactly like the staged path.
    const dup = await request("POST", "/actions/change/preview", {
      operation: "create",
      objectType: "Customer",
      values: { id: "C005", name: "Manual Five", region: "EU", amount: 1 },
    });
    expect(dup.statusCode).toBe(409);
    // A new key is created and shows up on the first page of the lazy list.
    const preview = await request("POST", "/actions/change/preview", {
      operation: "create",
      objectType: "Customer",
      values: { id: "C100", name: "Manual Hundred", region: "EU", amount: 1 },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const executed = await request("POST", "/actions/change/execute", {
      action: preview.json().action,
      hash: preview.json().hash,
      idempotencyKey: randomUUID(),
    });
    expect(executed.statusCode, executed.body).toBe(200);
    const f = (await page("type=Customer&limit=10&offset=0")).json();
    const c100 = f.items.filter((r: any) => r.data.key === "C100");
    expect(c100).toHaveLength(1);
    expect(c100[0].name).toBe("Customer C100");
    expect(c100[0].data.base.name).toBe("Manual Hundred");
    expect(c100[0].data.manual).toBe(true);
    // The manual record counts toward the total.
    expect(f.total).toBe(ROWS.length + 1);
  });

  it("keeps the staged path for small workspaces", async () => {
    await publish(true);
    const f = (await page("type=Customer&limit=10&offset=0")).json();
    expect(f.total).toBe(ROWS.length);
    expect(f.items).toHaveLength(10);
    expect(f.items[0].data).toMatchObject({
      type: "Customer",
      key: "C001",
      logicalId: logicalId("C001"),
    });
    // Staged objects are real resources; refs are not involved.
    const objects = await store.list(scope, "object");
    expect(objects.length).toBe(ROWS.length);
    expect(objects.some((o) => o.kind === "recordRef")).toBe(false);
  });
});
