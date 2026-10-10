import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { config } from "../apps/api/src/config.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { syncLocalSources } from "../apps/api/src/data-jobs.js";
import { unseal } from "../apps/api/src/security.js";

let mount: string;
const previousLocalDataPath = config.localDataPath;

beforeEach(async () => {
  mount = await mkdtemp(join(tmpdir(), "foundry-auto-import-"));
  config.localDataPath = mount;
  await writeFile(resolve(mount, "orders.parquet"), "placeholder");
  await mkdir(resolve(mount, "archive"), { recursive: true });
  await writeFile(resolve(mount, "archive", "2024.parquet"), "placeholder");
});
afterEach(async () => {
  config.localDataPath = previousLocalDataPath;
  await rm(mount, { recursive: true, force: true });
});

const workspace = async (store: MemoryStore) =>
  transaction(store, "global", async (tx) => {
    tx.put(resource("global", "workspaceRef", "Test", {}, "ws"));
  });

it("creates sources and actor-less sync jobs for un-imported mount files", async () => {
  const store = new MemoryStore();
  await workspace(store);

  expect(await syncLocalSources(store)).toBe(2);

  const sources = await store.list("ws", "source");
  expect(sources.map((s) => s.name).sort()).toEqual(
    ["archive" + sep + "2024.parquet", "orders.parquet"].sort(),
  );
  for (const source of sources) {
    expect(source.data.kind).toBe("local");
    expect(source.data.sync?.mode).toBe("manual");
    expect(unseal(source.data.secret)).toMatchObject({ key: source.name });
  }

  const jobs = await store.list("ws", "job");
  expect(jobs).toHaveLength(2);
  for (const job of jobs) {
    expect(job.data.type).toBe("sync");
    expect(job.data.status).toBe("queued");
    expect(job.data.actor).toBeUndefined();
    expect(
      sources.some((s) => s.id === job.data.sourceId),
    ).toBe(true);
  }
});

it("is idempotent and leaves existing sources untouched", async () => {
  const store = new MemoryStore();
  await workspace(store);

  expect(await syncLocalSources(store)).toBe(2);
  expect(await syncLocalSources(store)).toBe(0);
  expect(await store.list("ws", "source")).toHaveLength(2);
  expect(await store.list("ws", "job")).toHaveLength(2);

  await writeFile(resolve(mount, "new.parquet"), "placeholder");
  expect(await syncLocalSources(store)).toBe(1);
  expect(await store.list("ws", "source")).toHaveLength(3);
});

it("returns zero when the mount is missing", async () => {
  config.localDataPath = resolve(mount, "does-not-exist");
  const store = new MemoryStore();
  await workspace(store);

  expect(await syncLocalSources(store)).toBe(0);
  expect(await store.list("ws", "source")).toHaveLength(0);
});
