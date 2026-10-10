import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const execution = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../apps/api/src/executor.js", () => execution);

import { config } from "../apps/api/src/config.js";
import { ingestFile } from "../apps/api/src/datasets.js";
import { MemoryStore } from "../apps/api/src/store.js";

let dataDir: string;
const previousDataDir = config.dataDir;
const profile = {
  rows: 1,
  duplicateRows: 0,
  columns: [],
  sample: [],
  fingerprint: "fixture",
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "foundry-datasets-"));
  config.dataDir = dataDir;
  execution.execute.mockReset();
  execution.execute.mockResolvedValue({
    profile,
    version: "snapshot",
    rows: [],
  });
  await mkdir(resolve(dataDir, "incoming", "workspace"), { recursive: true });
  await writeFile(
    resolve(dataDir, "incoming", "workspace", "input.jsonl"),
    '{"id":1}\n',
  );
});
afterEach(async () => {
  config.dataDir = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

it("removes the staged input after the durable snapshot is registered", async () => {
  await ingestFile(
    new MemoryStore(),
    "workspace",
    "Fixture",
    "input.jsonl",
    undefined,
    "dataset",
    "snapshot",
  );
  await expect(
    stat(resolve(dataDir, "incoming", "workspace", "input.jsonl")),
  ).rejects.toThrow();
});

it("stores only three cached sample rows in dataset and version metadata", async () => {
  const store = new MemoryStore();
  const samples = Array.from({ length: 50 }, (_, index) => ({ index }));
  execution.execute.mockResolvedValueOnce({
    profile: { ...profile, sample: samples },
    version: "snapshot",
    rows: samples,
  });

  await ingestFile(
    store,
    "workspace",
    "Fixture",
    "input.jsonl",
    undefined,
    "dataset",
    "snapshot",
  );

  expect(execution.execute).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "ingest", limit: 3 }),
  );
  expect(
    (await store.get("workspace", "dataset"))?.data.profile.sample,
  ).toEqual(samples.slice(0, 3));
  expect(
    (await store.get("workspace", "snapshot"))?.data.profile.sample,
  ).toEqual(samples.slice(0, 3));
});

it("passes explicit approximate profiling through for a local retry", async () => {
  const store = new MemoryStore();
  const localSource = {
    path: "partition/source.parquet",
    fingerprint: { size: 123, mtimeMs: 456 },
  };

  await ingestFile(
    store,
    "workspace",
    "Fixture",
    "",
    undefined,
    "dataset",
    "snapshot",
    undefined,
    undefined,
    localSource,
    true,
  );

  expect(execution.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      sourcePath: localSource.path,
      approximateProfile: true,
      limit: 3,
    }),
  );
});

it("keeps the staged input when execution fails so a queued upload can retry", async () => {
  execution.execute.mockRejectedValueOnce(new Error("temporary failure"));
  await expect(
    ingestFile(
      new MemoryStore(),
      "workspace",
      "Fixture",
      "input.jsonl",
      undefined,
      "dataset",
      "snapshot",
    ),
  ).rejects.toThrow("temporary failure");
  expect(
    (
      await stat(resolve(dataDir, "incoming", "workspace", "input.jsonl"))
    ).isFile(),
  ).toBe(true);
});
