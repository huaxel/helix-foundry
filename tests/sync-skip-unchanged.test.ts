import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../apps/api/src/config.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { runSyncJob } from "../apps/api/src/data-jobs.js";
import { seal } from "../apps/api/src/security.js";

const execution = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../apps/api/src/executor.js", () => execution);

let mount: string;
const previousMount = config.localDataPath;
const previousDataDir = config.dataDir;
const profile = {
  rows: 1,
  duplicateRows: 0,
  columns: [],
  sample: [],
  fingerprint: "fixture",
};

beforeEach(async () => {
  mount = await mkdtemp(join(tmpdir(), "foundry-skip-"));
  config.localDataPath = mount;
  config.dataDir = await mkdtemp(join(tmpdir(), "foundry-skip-data-"));
  execution.execute.mockReset();
  execution.execute.mockResolvedValue({ profile, version: "v9", rows: [] });
  await writeFile(join(mount, "orders.parquet"), "placeholder");
});
afterEach(async () => {
  config.localDataPath = previousMount;
  config.dataDir = previousDataDir;
  await rm(mount, { recursive: true, force: true });
});

const setup = async (store: MemoryStore) => {
  await transaction(store, "global", async (tx) => {
    tx.put(resource("global", "workspaceRef", "Test", {}, "ws"));
  });
  await transaction(store, "ws", async (tx) => {
    tx.put(
      resource("ws", "source", "orders.parquet", {
        kind: "local",
        secret: seal({ key: "orders.parquet" }),
      }, "src1"),
    );
  });
};
const syncJob = (store: MemoryStore, id: string) =>
  transaction(store, "ws", async (tx) => {
    tx.put(resource("ws", "job", "Sync", { sourceId: "src1" }, id));
  }).then(() => ({ id, data: { sourceId: "src1" } }) as any);

it("profiles once, then skips unchanged files and re-profiles changed ones", async () => {
  const store = new MemoryStore();
  await setup(store);

  await runSyncJob(store, "ws", await syncJob(store, "j1"));
  expect(execution.execute).toHaveBeenCalledTimes(1);
  const ds1 = await store.get("ws", "source_src1");
  const ver1 = ds1?.data.activeVersion as string;
  expect(ver1).toBeTruthy();
  const fp1 = (await store.get("ws", ver1))?.data.sourceFingerprint;
  expect(fp1?.size).toBeGreaterThan(0);

  // Same bytes on disk: no re-profile, same active version, lastSync set.
  execution.execute.mockClear();
  await runSyncJob(store, "ws", await syncJob(store, "j2"));
  expect(execution.execute).not.toHaveBeenCalled();
  expect((await store.get("ws", "source_src1"))?.data.activeVersion).toBe(
    ver1,
  );
  expect(
    (await store.get("ws", "src1"))?.data.lastSync,
  ).toBeTruthy();

  // Changed bytes: profiles again.
  await appendFile(join(mount, "orders.parquet"), "more-bytes");
  await runSyncJob(store, "ws", await syncJob(store, "j3"));
  expect(execution.execute).toHaveBeenCalledTimes(1);
});
