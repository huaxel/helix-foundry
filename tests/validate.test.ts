import { it, expect, vi } from "vitest";
vi.mock("../apps/api/src/datasets.js", () => ({
  datasetTable: (id: string) => `t_${id}`,
  queryDatasets: async () => ({ rows: [{ k: 0 }], profile: { rows: 1 } }),
}));
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { runValidateJob } from "../apps/api/src/validate-job.js";

const store = new MemoryStore();
const scope = "validate_" + Date.now();
const suggestion = () => ({
  signature: "sig",
  hash: "h",
  summary: "Test",
  described: false,
  entities: [
    { id: "a", name: "A", anchorDatasetId: "da", members: [] },
    { id: "b", name: "B", anchorDatasetId: "db", members: [] },
  ],
  links: [
    {
      id: "catalog-a-x-b-y",
      name: "references",
      from: "a",
      to: "b",
      fromDatasetId: "da",
      fromColumn: "X",
      toDatasetId: "db",
      toColumn: "Y",
      totalRows: 10,
      matchedRows: 10,
      caseInsensitive: false,
      evidence: "declared",
    },
    {
      id: "catalog-b-p-a-q",
      name: "references",
      from: "b",
      to: "a",
      fromDatasetId: "db",
      fromColumn: "P",
      toDatasetId: "da",
      toColumn: "Q",
      totalRows: 10,
      matchedRows: 10,
      caseInsensitive: false,
      evidence: "declared",
    },
  ],
  notes: [],
  unplaced: [],
});
async function setup() {
  await transaction(store, scope, async (tx) => {
    tx.put(resource(scope, "workspace", "Validate", {}, "workspace"));
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      onboarding: { ontologySuggestion: suggestion() },
    });
  });
}
const job = (signature: string) =>
  resource(scope, "job", "Validate catalog links", {
    type: "validate",
    status: "queued",
    background: true,
    onboardingSignature: signature,
  });

it("flags sampled-miss links without touching verified ones or the hash", async () => {
  await setup();
  const j = job("sig");
  await transaction(store, scope, async (tx) => tx.put(j));
  const out = (await runValidateJob(store, scope, j)) as any;
  expect(out).toEqual({ checked: 2, suspect: 1 });
  const stored = (await store.get(scope, "workspace"))?.data.onboarding
    .ontologySuggestion;
  expect(stored.hash).toBe("h");
  expect(stored.notes).toHaveLength(1);
  expect(stored.notes[0]).toMatchObject({
    kind: "unmatched",
    links: ["catalog-b-p-a-q"],
  });
  // Re-running adds no duplicates.
  await runValidateJob(store, scope, j);
  expect(
    (await store.get(scope, "workspace"))?.data.onboarding.ontologySuggestion
      .notes,
  ).toHaveLength(1);
});

it("does nothing for stale signatures or link-free suggestions", async () => {
  await setup();
  expect(await runValidateJob(store, scope, job("other"))).toBeNull();
  await transaction(store, scope, async (tx) => {
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      onboarding: {
        ontologySuggestion: { ...suggestion(), links: [] },
      },
    });
  });
  expect(await runValidateJob(store, scope, job("sig"))).toBeNull();
  expect(
    (await store.get(scope, "workspace"))?.data.onboarding.ontologySuggestion
      .notes,
  ).toEqual([]);
});
