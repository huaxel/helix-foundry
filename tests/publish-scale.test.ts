import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execute as localExecute } from "../services/executor/src/engine.js";
let calls = 0;
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => {
    calls++;
    return localExecute(job);
  },
}));
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows } from "../apps/api/src/datasets.js";
import {
  saveProposal,
  publishProposal,
} from "../apps/api/src/assistant.js";
import { BundleSchema, datasetTable } from "../packages/shared/src/index.js";

const scope = "scale-" + randomUUID();

it("publishes dashboard-only without staging rows or queries", async () => {
  const store = new MemoryStore();
  await transaction(store, scope, async (tx) =>
    tx.put(resource(scope, "workspace", "Scale", {}, "workspace")),
  );
  await transaction(store, "global", async (tx) =>
    tx.put(
      resource("global", "member", "Editor", { role: "editor" }, `actor:${scope}`),
    ),
  );
  const customers = await ingestRows(
    store,
    scope,
    "Customers",
    [
      { id: "A", region: "EU" },
      { id: "B", region: "NA" },
    ],
    undefined,
    "customers",
  );
  // Pretend planetary scale: validation still runs against the real rows,
  // but publishing must not page through the claimed ones.
  await transaction(store, scope, async (tx) => {
    const ds = (await tx.get(customers.id))!;
    tx.update(ds, {
      ...ds.data,
      profile: { ...ds.data.profile, rows: 50_000_000 },
    });
  });
  const bundle = BundleSchema.parse({
    summary: "Customer count at planetary scale",
    assumptions: ["A customer is one row."],
    catalog: [],
    pipelines: [],
    ontology: [
      { name: "Customer", datasetId: customers.id, primaryKey: "id", properties: ["id", "region"] },
    ],
    relationships: [],
    dashboards: [
      {
        name: "Overview",
        widgets: [
          {
            title: "Customers",
            type: "metric",
            inputs: [customers.id],
            sql: `SELECT count(*) customers FROM ${datasetTable(customers.id)}`,
          },
        ],
      },
    ],
    actions: [],
  });
  const p = await saveProposal(store, scope, bundle);
  expect(p.data.validation.valid).toBe(true);
  calls = 0;
  await publishProposal(store, scope, p.id, p.data.hash, "actor", "ok", {
    stageRecords: false,
  });
  expect(calls).toBe(0);
  expect((await store.list(scope, "object")).length).toBe(0);
  expect((await store.list(scope, "dashboard")).length).toBe(1);
  expect((await store.list(scope, "publication")).length).toBe(1);
  const types = await store.list(scope, "objectType");
  expect(types.length).toBe(1);
  expect(types[0].data.objectCount).toBe(50_000_000);
  expect(
    (await store.get(scope, "workspace"))?.data.activeGeneration,
  ).toBeTruthy();
  vi.restoreAllMocks();
});
