import { it, expect } from "vitest";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { runValidateJob } from "../apps/api/src/validate-job.js";

const store = new MemoryStore();
const scope = "validate_" + Date.now();
const col = (name: string) => ({
  name,
  type: "VARCHAR",
  nulls: 0,
  distinct: 3,
  examples: [],
  sensitive: false,
  primaryKey: false,
});
const catalog = {
  version: 1 as const,
  name: "Audit catalog",
  tables: [
    { table: "CUST", keys: [["CUST_ID"]] },
    { table: "ORD", keys: [["ORD_ID"]] },
  ],
  joins: [
    {
      leftTable: "ORD",
      leftKey: "CUST_ID",
      rightTable: "CUST",
      rightKey: "CUST_ID",
    },
    { leftTable: "ORD", leftKey: "MISSING", rightTable: "CUST", rightKey: "CUST_ID" },
    { leftTable: "GHOST", leftKey: "X", rightTable: "CUST", rightKey: "CUST_ID" },
  ],
  domains: [],
};
const link = {
  id: "catalog-ord-cust-id-cust-cust-id",
  name: "references",
  from: "order",
  to: "customer",
  fromDatasetId: "d-ord",
  fromColumn: "CUST_ID",
  toDatasetId: "d-cust",
  toColumn: "CUST_ID",
  totalRows: 4,
  matchedRows: 4,
  caseInsensitive: false,
  evidence: "declared",
};
const suggestion = () => ({
  signature: "sig",
  hash: "h",
  summary: "Two entities.",
  described: false,
  entities: [],
  links: [link],
  notes: [],
  unplaced: [],
});
async function setup() {
  await transaction(store, scope, async (tx) => {
    tx.put(resource(scope, "workspace", "Validate", {}, "workspace"));
    tx.put(
      resource(scope, "dataset", "ORD.parquet", {
        activeVersion: "v1",
        profile: {
          rows: 4,
          columns: [col("ORD_ID"), col("CUST_ID")],
          sample: [],
          fingerprint: "o",
        },
      }, "d-ord"),
    );
    tx.put(
      resource(scope, "dataset", "CUST.parquet", {
        activeVersion: "v1",
        profile: {
          rows: 3,
          columns: [col("CUST_ID"), col("NAME")],
          sample: [],
          fingerprint: "c",
        },
      }, "d-cust"),
    );
    tx.put(resource(scope, "catalog", "Audit catalog", catalog, "catalog"));
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      onboarding: { ontologySuggestion: suggestion() },
    });
  });
}
const job = (signature: string) => {
  const j = resource(scope, "job", "Validate catalog links", {
    type: "validate",
    status: "queued",
    background: true,
    onboardingSignature: signature,
  });
  return j;
};
async function storeJob(signature: string) {
  const j = job(signature);
  await transaction(store, scope, async (tx) => tx.put(j));
  return j;
}

it("audits join coverage into the summary without touching the hash", async () => {
  await setup();
  const j = await storeJob("sig");
  const out = (await runValidateJob(store, scope, j)) as any;
  expect(out).toMatchObject({
    applied: 1,
    skipped: 2,
    outOfScope: 1,
    missingColumn: 1,
    updated: true,
  });
  const stored = (await store.get(scope, "workspace"))?.data.onboarding
    .ontologySuggestion;
  expect(stored.hash).toBe("h");
  expect(stored.summary).toBe(
    "Two entities. Plus 1 of 3 catalog joins applied as links " +
      "(1 tables out of scope, 1 unresolvable keys, 0 same-entity or duplicate).",
  );
  // Re-running neither duplicates the headline nor rewrites.
  const again = (await runValidateJob(store, scope, j)) as any;
  expect(again.updated).toBe(false);
  expect(
    (await store.get(scope, "workspace"))?.data.onboarding.ontologySuggestion
      .summary,
  ).toBe(stored.summary);
});

it("does nothing for stale signatures, or without catalog joins", async () => {
  await setup();
  expect(await runValidateJob(store, scope, job("other"))).toBeNull();
  await transaction(store, scope, async (tx) => {
    const c = (await tx.get("catalog"))!;
    tx.update(c, { ...c.data, joins: [] });
  });
  const j = await storeJob("sig");
  expect(await runValidateJob(store, scope, j)).toBeNull();
});
