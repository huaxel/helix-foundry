import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execute as localExecute } from "../services/executor/src/engine.js";
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => localExecute(job),
}));
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore } from "../apps/api/src/store.js";
import { config } from "../apps/api/src/config.js";
import { datasetTable } from "../packages/shared/src/index.js";
import { runUploadJob } from "../apps/api/src/data-jobs.js";

let store: MemoryStore;
let app: Awaited<ReturnType<typeof createApp>>;
let scope: string;

const request = (method: any, path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1/workspaces/${scope}` + path,
    payload: payload as any,
  });

beforeEach(async () => {
  store = new MemoryStore();
  app = await createApp(store);
  await app.ready();
  const r = await app.inject({ method: "GET", url: "/api/v1/me" });
  scope = r.json().workspaces[0].id;
});

afterEach(async () => {
  await app.close();
  for (const d of ["incoming", "datasets"])
    await rm(resolve(config.dataDir, d, scope), {
      recursive: true,
      force: true,
    });
});

const ROWS = [
  { id: 1, region: "EU", amount: 10 },
  { id: 2, region: "EU", amount: 20 },
  { id: 3, region: "US", amount: 30 },
  { id: 4, region: "AP", amount: 40 },
];

// A valid multipart/form-data body: the closing boundary must be preceded by
// \r\n, otherwise the file part never terminates and req.file() hangs.
const multipartCsv = (boundary: string, filename: string, csv: string) =>
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
  `Content-Type: text/csv\r\n\r\n` +
  csv +
  `\r\n--${boundary}--\r\n`;

it("the /ingest route partitions a dataset and /query prunes to a partition", async () => {
  const ing = await request("POST", "/ingest", {
    name: "Sales",
    rows: ROWS,
    partitionColumn: "region",
  });
  expect(ing.statusCode).toBe(200);
  const datasetId = ing.json().id;

  // The active version is partitioned (three regions).
  const ds = await store.get(scope, datasetId);
  const version = await store.get(scope, ds!.data.activeVersion);
  expect(version!.data.partitionColumn).toBe("region");
  expect(version!.data.partitions).toHaveLength(3);

  const table = datasetTable(datasetId);

  // A query scoped to the EU partition opens only that partition.
  const q = await request("POST", "/query", {
    inputs: [datasetId],
    sql: `SELECT region, sum(amount) total FROM ${table} GROUP BY region ORDER BY region`,
    filters: [{ datasetId, column: "region", value: "EU" }],
  });
  expect(q.statusCode).toBe(200);
  expect(q.json().rows).toEqual([{ region: "EU", total: "30" }]);

  // A query with no partition filter reads all partitions.
  const qAll = await request("POST", "/query", {
    inputs: [datasetId],
    sql: `SELECT region, count(*) n FROM ${table} GROUP BY region ORDER BY region`,
  });
  expect(qAll.statusCode).toBe(200);
  expect(qAll.json().rows).toEqual([
    { region: "AP", n: "1" },
    { region: "EU", n: "2" },
    { region: "US", n: "1" },
  ]);

  // A partition filter matching nothing returns an empty result.
  const qEmpty = await request("POST", "/query", {
    inputs: [datasetId],
    sql: `SELECT count(*) n FROM ${table}`,
    filters: [{ datasetId, column: "region", value: "ZZ" }],
  });
  expect(qEmpty.statusCode).toBe(200);
  expect(qEmpty.json().rows).toEqual([]);
});

it("the /ingest route without partitionColumn keeps a single-file dataset", async () => {
  const ing = await request("POST", "/ingest", { name: "Plain", rows: ROWS });
  expect(ing.statusCode).toBe(200);
  const ds = await store.get(scope, ing.json().id);
  const version = await store.get(scope, ds!.data.activeVersion);
  expect(version!.data.partitions).toBeUndefined();
  expect(version!.data.file).toBe(ds!.data.activeVersion + ".parquet");
});

it("the /onboarding/uploads route partitions via the queued upload job", async () => {
  const boundary = "partition-upload-boundary";
  const csv = "id,region,amount\n1,EU,10\n2,EU,20\n3,US,30\n4,AP,40\n";
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${scope}/onboarding/uploads?partitionColumn=region`,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "idempotency-key": "partition-upload-op",
    },
    payload: multipartCsv(boundary, "Sales.csv", csv),
  });
  expect(r.statusCode, r.body).toBe(200);
  const job = (await store.get(scope, r.json().id))!;
  // The queued upload job captured the partition column.
  expect(job.data.partitionColumn).toBe("region");

  // Running the job produces a partitioned dataset (three regions).
  await runUploadJob(store, scope, job);
  const ds = await store.get(scope, job.data.datasetId);
  expect(ds?.kind).toBe("dataset");
  const version = await store.get(scope, ds!.data.activeVersion);
  expect(version!.data.partitionColumn).toBe("region");
  expect(version!.data.partitions).toHaveLength(3);
});
