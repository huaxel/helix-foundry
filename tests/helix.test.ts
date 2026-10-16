import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { HelixStore, transaction, resource } from "../apps/api/src/store.js";
import { config } from "../apps/api/src/config.js";
it.skipIf(process.env.TEST_HELIX !== "1")(
  "persists atomic scoped changes and graph relationships in real HelixDB",
  async () => {
    const store = new HelixStore();
    await store.init();
    const scope = "test-" + randomUUID();
    await transaction(store, scope, async (tx) => {
      tx.put(resource(scope, "object", "Alice", {}, "a"));
      tx.put(resource(scope, "object", "Bob", {}, "b"));
    });
    await transaction(store, scope, async (tx) => {
      tx.put(
        resource(
          scope,
          "relation",
          "Knows",
          { from: "a", to: "b", generation: "g" },
          "rel",
        ),
      );
    });
    expect(await store.neighbors(scope, "a")).toEqual(["b"]);
    expect(await store.get("other", "a")).toBeUndefined();
    const v = await store.version(scope);
    expect(
      await store.commit(scope, v - 1, [
        { put: resource(scope, "test", "stale", {}, "stale") },
      ]),
    ).toBe(false);
    expect(await store.get(scope, "stale")).toBeUndefined();
    await transaction(store, scope, async (tx) => tx.delete("rel"));
    expect(await store.neighbors(scope, "a")).toEqual([]);
    const reopened = new HelixStore();
    expect((await reopened.get(scope, "a"))?.name).toBe("Alice");
    await transaction(store, scope, async (tx) => {
      for (const r of await tx.list()) tx.delete(r.id);
    });
  },
);
it("refuses a transaction too large for one HelixDB request, and says what to do", async () => {
  let sends = 0;
  let failWrite: unknown = null;
  const store = new HelixStore();
  store.client = {
    query: () => ({ send: async () => ({}) }),
    requestBuilder: () => ({
      shouldAwaitDurability: () => ({
        query: () => ({
          send: async () => {
            sends++;
            if (failWrite) throw failWrite;
            return { guard: [1] };
          },
        }),
      }),
    }),
  } as any;
  const big = resource("w", "source", "Big", {
    discovery: "x".repeat(config.helixWriteLimit),
  });
  const tooLarge = {
    statusCode: 413,
    message: expect.stringMatching(/Select fewer tables at once/),
  };
  await expect(store.commit("w", 1, [{ put: big }])).rejects.toMatchObject(
    tooLarge,
  );
  // The write never went out: only the pre-check read ran.
  expect(sends).toBe(0);
  // HelixDB's own limit may sit lower; its refusal says the same.
  failWrite = new Error("failed to read request body: length limit exceeded");
  await expect(
    store.commit("w", 1, [{ put: resource("w", "source", "Small") }]),
  ).rejects.toMatchObject(tooLarge);
  expect(sends).toBe(1);
});
