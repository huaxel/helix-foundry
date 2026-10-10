import { expect, it } from "vitest";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { onboardingState } from "../apps/api/src/onboarding-state.js";

const setup = async () => {
  const store = new MemoryStore();
  await transaction(store, "global", async (tx) => {
    tx.put(resource("global", "workspaceRef", "Test", {}, "ws"));
  });
  await transaction(store, "ws", async (tx) => {
    tx.put(
      resource("ws", "workspace", "Test", { activeGeneration: null }, "workspace"),
    );
    // One ready manual dataset so the empty-datasets rule doesn't fire.
    tx.put(
      resource(
        "ws",
        "dataset",
        "Manual",
        {
          sourceId: "manual-source",
          activeVersion: "v1",
          profile: { rows: 10, columns: [], sample: [], fingerprint: "x" },
        },
        "manual-dataset",
      ),
    );
  });
  return store;
};

it("does not block setup on queued bulk auto-imports", async () => {
  const store = await setup();
  await transaction(store, "ws", async (tx) => {
    const source = tx.put(
      resource("ws", "source", "auto.parquet", {
        kind: "local",
        connectionId: "connection_local-auto",
      }),
    );
    tx.put(
      resource("ws", "job", source.name, {
        type: "sync",
        sourceId: source.id,
        status: "queued",
      }),
    );
  });
  const state = await onboardingState(store, "ws");
  expect(state.blockers).toEqual([]);
  expect(state.inputsReady).toBe(true);
});

it("still blocks on queued manual imports", async () => {
  const store = await setup();
  await transaction(store, "ws", async (tx) => {
    const source = tx.put(
      resource("ws", "source", "manual-table", {
        kind: "postgres",
        connectionId: "connection_manual-123",
      }),
    );
    tx.put(
      resource("ws", "job", source.name, {
        type: "sync",
        sourceId: source.id,
        status: "queued",
      }),
    );
  });
  const state = await onboardingState(store, "ws");
  expect(state.inputsReady).toBe(false);
  expect(
    state.blockers.some((b) => b.includes("still in progress")),
  ).toBe(true);
});
