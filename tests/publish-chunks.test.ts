import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execute as localExecute } from "../services/executor/src/engine.js";
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => localExecute(job),
}));
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows } from "../apps/api/src/datasets.js";
import {
  saveProposal,
  publishProposal,
} from "../apps/api/src/assistant.js";
import { BundleSchema, datasetTable } from "../packages/shared/src/index.js";

const scope = "chunks-" + randomUUID();

it("publishes hundreds of assets across chunked commits", async () => {
  const store = new MemoryStore();
  await transaction(store, scope, async (tx) =>
    tx.put(resource(scope, "workspace", "Chunks", {}, "workspace")),
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
  const types = Array.from({ length: 20 }, (_, i) => ({
    name: `Customer${i}`,
    datasetId: customers.id,
    primaryKey: "id",
    properties: ["id", "region"],
  }));
  const catalog = Array.from({ length: 150 }, (_, i) => ({
    datasetId: customers.id,
    description: `Catalog entry ${i}`,
    tags: [`t${i}`],
  }));
  const bundle = BundleSchema.parse({
    summary: "Many catalog entries share one small dataset",
    assumptions: ["One dataset backs every entry."],
    catalog,
    pipelines: [],
    ontology: types,
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
  await publishProposal(store, scope, p.id, p.data.hash, "actor");
  expect((await store.list(scope, "objectType")).length).toBe(20);
  expect((await store.list(scope, "dashboard")).length).toBe(1);
  expect((await store.list(scope, "publication")).length).toBe(1);
  expect(
    (await store.get(scope, "workspace"))?.data.activeGeneration,
  ).toBeTruthy();
  vi.restoreAllMocks();
}, 300000);
