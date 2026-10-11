import { it, expect, vi, afterEach } from "vitest";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { buildWorkspace } from "../apps/api/src/assistant.js";
import { onboardingState } from "../apps/api/src/onboarding-state.js";
import { Provider } from "../apps/api/src/providers.js";

const store = new MemoryStore();
const scope = "proposals_" + Date.now();
afterEach(() => vi.restoreAllMocks());

const entity = (id: string) => ({
  id,
  name: `Slug ${id}`,
  description: "",
  kind: "record" as const,
  anchorDatasetId: "d1",
  key: "ID",
  rows: 10,
  members: [
    {
      datasetId: "d1",
      datasetName: "TBL",
      source: "upload",
      key: "ID",
      rows: 10,
      matched: 10,
      via: null,
    },
  ],
  properties: [],
});
async function setup(count: number) {
  const entities = Array.from({ length: count }, (_, i) => entity(`e${i}`));
  await transaction(store, "global", async (tx) => {
    tx.put(resource("global", "member", "owner", { role: "owner" }, `u:${scope}`));
  });
  await transaction(store, scope, async (tx) => {
    tx.put(resource(scope, "workspace", "Proposals", {}, "workspace"));
    const profile = {
      rows: 10,
      columns: [
        {
          name: "ID",
          type: "VARCHAR",
          nulls: 0,
          distinct: 10,
          examples: [],
          sensitive: false,
          primaryKey: true,
        },
      ],
      sample: [],
      fingerprint: "p",
    };
    tx.put(
      resource(scope, "dataset", "T1", { description: "", activeVersion: "v1", profile }, "d1"),
    );
    tx.put(
      resource(scope, "dataset", "T2", { description: "", activeVersion: "v1", profile }, "d2"),
    );
    // One catalog entry grounds every fixture entity (shared anchor table).
    tx.put(
      resource(scope, "catalog", "Test catalog", {
        version: 1,
        tables: [{ table: "T1", definition: "Test records." }],
        joins: [],
        domains: [],
      }, "catalog"),
    );
    tx.put(
      resource(scope, "provider", "AI", {
        settings: { provider: "local", model: "test-model" },
      }, "provider"),
    );
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      onboarding: {
        ontologySuggestion: {
          signature: "sig",
          hash: "h",
          summary: "",
          described: false,
          entities,
          links: [],
          notes: [],
          unplaced: [],
        },
      },
    });
  });
  // The run must carry the live input signature, or the task refuses as stale.
  const sig = (await onboardingState(store, scope)).signature;
  await transaction(store, scope, async (tx) => {
    const w = (await tx.get("workspace"))!;
    const current = w.data.onboarding.ontologySuggestion;
    tx.update(w, {
      ...w.data,
      onboarding: {
        ontologySuggestion: { ...current, signature: sig },
      },
    });
    tx.put(
      resource(scope, "run", "Describe the suggested ontology", {
        goal: "Describe the suggested ontology",
        intent: "build",
        authority: { userId: "u", readOnly: false },
        status: "queued",
        stage: "queued",
        events: [],
        calls: 0,
        tokens: 0,
        task: "propose_names",
        datasetIds: ["d1", "d2"],
        onboardingSignature: sig,
        ontologyHash: "h",
      }, "run-describe"),
    );
  });
}
function mockGenerate() {
  return vi.spyOn(Provider.prototype, "generate").mockImplementation(
    async (_system: any, context: any) => {
      const items = (context.ontology?.entities || []) as any[];
      if (items.length && items[0].slug !== undefined)
        return {
          value: {
            names: items.map((e) => ({ id: e.id, name: `Proposed ${e.id}` })),
          },
          tokens: 12,
        };
      return {
        value: {
          summary: "S",
          entities: items.map((e) => ({ id: e.id, description: `${e.id} desc` })),
          links: [],
        },
        tokens: 12,
      };
    },
  );
}

it("proposes bulk names for large grounded slug sets in batches", async () => {
  await setup(55);
  const ai = mockGenerate();
  await buildWorkspace(store, scope, "run-describe");
  // Proposals only (no describe calls): batches of 10 (6 calls).
  expect(ai).toHaveBeenCalledTimes(6);
  const stored = (await store.get(scope, "workspace"))?.data.onboarding
    .ontologySuggestion;
  expect(Object.keys(stored.nameProposals || {})).toHaveLength(55);
  expect(stored.nameProposals.e0).toBe("Proposed e0");
  expect(stored.nameProposals.e54).toBe("Proposed e54");
});

it("proposes grounded names without a bulk gate when queued directly", async () => {
  await setup(10);
  const ai = mockGenerate();
  await buildWorkspace(store, scope, "run-describe");
  expect(ai).toHaveBeenCalledTimes(1);
  const stored = (await store.get(scope, "workspace"))?.data.onboarding
    .ontologySuggestion;
  expect(Object.keys(stored.nameProposals || {})).toHaveLength(10);
});
