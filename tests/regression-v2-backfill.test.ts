// Regression tests for the v1 -> v2 migration hot-path bugs found in
// production (see docs/VALIDATION.md). These lock in two fixes so they cannot
// silently regress:
//   1. commit() must treat the pinned HelixDB v0.0.6's flaky cascades
//      planner error (internal_planner_error) as retryable, not a 500.
//   2. isAppProcess() must gate the backfill/version-bump to the API
//      entrypoint only — never the worker or the executor (which run their
//      own server.js).
import { it, expect, describe, afterEach } from "vitest";
import {
  HelixStore,
  isAppProcess,
  resource,
} from "../apps/api/src/store.js";

const plannerError = () =>
  Object.assign(
    new Error(
      "got error from server: planner error: unsupported cascades plan: " +
        "selected optimizer result did not contain a best physical alternative",
    ),
    { kind: "Remote", code: "internal_planner_error", statusCode: 400 },
  );

function stubbedStore(
  read: () => unknown,
  write: () => unknown,
): HelixStore {
  const store = new HelixStore();
  (store as any).read = read;
  (store as any).write = write;
  return store;
}
const aPut = () => ({ put: resource("ws", "job", "j", { status: "queued" }, "j1") });

describe("commit() transient-failure handling", () => {
  it("treats the flaky HelixDB planner error as retryable (returns false, does not throw)", async () => {
    const store = stubbedStore(async () => ({}), async () => {
      throw plannerError();
    });
    const ok = await store.commit("ws", 1, [aPut()]);
    expect(ok).toBe(false);
  });

  it("treats a planner error surfaced only in the message as retryable too", async () => {
    const store = stubbedStore(async () => ({}), async () => {
      throw new Error("planner error: unsupported cascades plan");
    });
    expect(await store.commit("ws", 1, [aPut()])).toBe(false);
  });

  it("re-throws non-transient write errors (does not swallow them)", async () => {
    const store = stubbedStore(async () => ({}), async () => {
      throw new Error("boom: disk full");
    });
    await expect(store.commit("ws", 1, [aPut()])).rejects.toThrow("disk full");
  });
});

describe("isAppProcess() backfill ownership gate", () => {
  const origArgv = process.argv;
  const origForce = process.env.HELIX_FORCE_BACKFILL;
  const withArgv = (entry: string, fn: () => void) => {
    const prev = process.argv;
    process.argv = ["node", entry];
    try {
      fn();
    } finally {
      process.argv = prev;
    }
  };
  afterEach(() => {
    process.argv = origArgv;
    if (origForce === undefined) delete process.env.HELIX_FORCE_BACKFILL;
    else process.env.HELIX_FORCE_BACKFILL = origForce;
  });

  it("identifies the API entrypoint (prod js and dev ts) as the app", () => {
    delete process.env.HELIX_FORCE_BACKFILL;
    withArgv("dist/apps/api/src/server.js", () => expect(isAppProcess()).toBe(true));
    withArgv("/home/u/helix-foundry/apps/api/src/server.ts", () =>
      expect(isAppProcess()).toBe(true),
    );
  });

  it("never identifies the worker or the executor as the app", () => {
    delete process.env.HELIX_FORCE_BACKFILL;
    // worker: same apps/api dir but a different entry file
    withArgv("dist/apps/api/src/worker.js", () => expect(isAppProcess()).toBe(false));
    // executor: its OWN server.js must not be mistaken for the app's
    withArgv("dist/services/executor/src/server.js", () =>
      expect(isAppProcess()).toBe(false),
    );
    withArgv("dist/scripts/doctor.js", () => expect(isAppProcess()).toBe(false));
  });

  it("honors the explicit HELIX_FORCE_BACKFILL override", () => {
    process.env.HELIX_FORCE_BACKFILL = "1";
    withArgv("dist/apps/api/src/worker.js", () => expect(isAppProcess()).toBe(true));
    process.env.HELIX_FORCE_BACKFILL = "0";
    withArgv("dist/apps/api/src/worker.js", () => expect(isAppProcess()).toBe(false));
  });
});
