import { beforeEach, expect, it, vi } from "vitest";

const execution = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../apps/api/src/executor.js", () => execution);

import { ingestFile, queryDatasets } from "../apps/api/src/datasets.js";
import {
  MemoryStore,
  resource,
  transaction,
  type Store,
} from "../apps/api/src/store.js";
import { datasetTable } from "../packages/shared/src/index.js";

const profile = {
  rows: 3,
  duplicateRows: 0,
  columns: [
    {
      name: "id",
      type: "BIGINT",
      nulls: 0,
      distinct: 3,
      examples: [],
      sensitive: false,
      primaryKey: true,
    },
    {
      name: "region",
      type: "VARCHAR",
      nulls: 0,
      distinct: 2,
      examples: [],
      sensitive: false,
      primaryKey: false,
    },
  ],
  sample: [],
  fingerprint: "fixture",
};

// The partition manifest for version "v1": two partitions of a dataset split
// by `region`.
const partitions = [
  { key: "EU", file: "v1/eu.parquet", rows: 2 },
  { key: "US", file: "v1/us.parquet", rows: 1 },
];

const scope = "workspace";
const datasetId = "ds-partitioned";
const versionId = "v1";

let store: Store;

async function seedPartitionedDataset() {
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "dataset",
        "Sales",
        {
          table: datasetTable(datasetId),
          activeVersion: versionId,
          versions: [versionId],
          profile,
        },
        datasetId,
      ),
    );
    tx.put(
      resource(
        scope,
        "version",
        "Sales",
        { datasetId, profile, partitionColumn: "region", partitions },
        versionId,
      ),
    );
  });
}

beforeEach(() => {
  store = new MemoryStore();
  execution.execute.mockReset();
  execution.execute.mockResolvedValue({ profile, version: "q", rows: [] });
});

it("ingestFile stores the partition manifest on the version resource", async () => {
  execution.execute.mockResolvedValueOnce({
    profile,
    version: "vnew",
    rows: [],
    partitions,
  });
  await ingestFile(
    store,
    scope,
    "Sales",
    "input.jsonl",
    undefined,
    datasetId,
    "vnew",
    { partitionColumn: "region" },
  );
  const v = await store.get(scope, "vnew");
  expect(v?.data.partitionColumn).toBe("region");
  expect(v?.data.partitions).toEqual(partitions);
  // A partitioned version has no single snapshot file or mounted source.
  expect(v?.data.file).toBeUndefined();
  expect(v?.data.sourcePath).toBeUndefined();
});

it("ingestFile rejects an invalid partition column before reaching the executor", async () => {
  await expect(
    ingestFile(store, scope, "Sales", "input.jsonl", undefined, datasetId, "vbad", {
      partitionColumn: "x".repeat(101),
    }),
  ).rejects.toThrow("Invalid partition column");
  await expect(
    ingestFile(store, scope, "Sales", "input.jsonl", undefined, datasetId, "vbad2", {
      partitionColumn: "a\0b",
    }),
  ).rejects.toThrow("Invalid partition column");
  expect(execution.execute).not.toHaveBeenCalled();
});

it("queryDatasets prunes to the matching partition on a partition-key filter", async () => {
  await seedPartitionedDataset();
  execution.execute.mockResolvedValueOnce({
    profile,
    version: "q",
    rows: [{ n: "2" }],
  });
  const r = await queryDatasets(
    store,
    scope,
    [datasetId],
    "SELECT count(*) n FROM sales",
    { filters: [{ datasetId, column: "region", value: "EU" }] },
  );
  expect(execution.execute).toHaveBeenCalledTimes(1);
  const job: any = execution.execute.mock.calls[0][0];
  // Only the EU partition file is sent to the executor.
  expect(job.inputs[0].files).toEqual(["v1/eu.parquet"]);
  // The manifest is not leaked to the executor.
  expect(job.inputs[0].partitions).toBeUndefined();
  expect(job.inputs[0].partitionColumn).toBeUndefined();
  expect(r.rows).toEqual([{ n: "2" }]);
});

it("queryDatasets keeps all partitions when the filter is not on the partition key", async () => {
  await seedPartitionedDataset();
  await queryDatasets(store, scope, [datasetId], "SELECT count(*) n FROM sales", {
    filters: [{ datasetId, column: "id", value: 1 }],
  });
  const job: any = execution.execute.mock.calls[0][0];
  expect(job.inputs[0].files).toEqual(["v1/eu.parquet", "v1/us.parquet"]);
});

it("queryDatasets sends every partition when there is no filter", async () => {
  await seedPartitionedDataset();
  await queryDatasets(store, scope, [datasetId], "SELECT count(*) n FROM sales");
  const job: any = execution.execute.mock.calls[0][0];
  expect(job.inputs[0].files).toEqual(["v1/eu.parquet", "v1/us.parquet"]);
});

it("queryDatasets short-circuits an empty partition match to zero rows", async () => {
  await seedPartitionedDataset();
  const r: any = await queryDatasets(
    store,
    scope,
    [datasetId],
    "SELECT count(*) n FROM sales",
    { filters: [{ datasetId, column: "region", value: "ZZ" }] },
  );
  // No executor call: read_parquet([]) would throw, so we return empty early.
  expect(execution.execute).not.toHaveBeenCalled();
  expect(r.rows).toEqual([]);
  expect(r.profile.rows).toBe(0);
  expect(r.state).toBe("dataset_snapshot");
});

it("queryDatasets does not short-circuit a multi-input query when one input prunes to zero", async () => {
  await seedPartitionedDataset();
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "dataset",
        "Plain",
        {
          table: datasetTable("ds-plain"),
          activeVersion: "p1",
          versions: ["p1"],
          profile,
        },
        "ds-plain",
      ),
    );
    tx.put(
      resource(
        scope,
        "version",
        "Plain",
        { datasetId: "ds-plain", profile, file: "p1.parquet" },
        "p1",
      ),
    );
  });
  execution.execute.mockResolvedValueOnce({
    profile,
    version: "q",
    rows: [{ n: "3" }],
  });
  // The SQL may ignore the pruned table or outer-join it: zeroing the whole
  // result would be wrong (and read_parquet([]) would throw), so the pruned
  // input falls back to its full file set with the filter still attached.
  const r = await queryDatasets(
    store,
    scope,
    [datasetId, "ds-plain"],
    "SELECT count(*) n FROM plain",
    { filters: [{ datasetId, column: "region", value: "ZZ" }] },
  );
  expect(execution.execute).toHaveBeenCalledTimes(1);
  const job: any = execution.execute.mock.calls[0][0];
  expect(job.inputs[0].files).toEqual(["v1/eu.parquet", "v1/us.parquet"]);
  expect(job.inputs[0].filters).toEqual([
    { datasetId, column: "region", value: "ZZ" },
  ]);
  expect(job.inputs[1].files).toBeUndefined();
  expect(r.rows).toEqual([{ n: "3" }]);
});

it("queryDatasets prunes a null filter to the null partition", async () => {
  // A dataset split by region where some rows have a null region (key "").
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(
        scope,
        "dataset",
        "Sales",
        {
          table: datasetTable(datasetId),
          activeVersion: versionId,
          versions: [versionId],
          profile,
        },
        datasetId,
      ),
    );
    tx.put(
      resource(
        scope,
        "version",
        "Sales",
        {
          datasetId,
          profile,
          partitionColumn: "region",
          partitions: [
            { key: "EU", file: "v1/eu.parquet", rows: 2 },
            { key: "", file: "v1/__null__.parquet", rows: 1 },
          ],
        },
        versionId,
      ),
    );
  });
  await queryDatasets(store, scope, [datasetId], "SELECT count(*) n FROM sales", {
    filters: [{ datasetId, column: "region", value: null }],
  });
  const job: any = execution.execute.mock.calls[0][0];
  // The null filter selects the null partition (key ""), not an empty set.
  expect(job.inputs[0].files).toEqual(["v1/__null__.parquet"]);
});
