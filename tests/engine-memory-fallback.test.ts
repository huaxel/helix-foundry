import { beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const duckdb = vi.hoisted(() => {
  const runAndReadAll = vi.fn();
  const connection = {
    run: vi.fn(),
    runAndReadAll,
    extractStatements: vi.fn(async () => ({ count: 1 })),
    closeSync: vi.fn(),
  };
  const db = {
    connect: vi.fn(async () => connection),
    closeSync: vi.fn(),
  };
  return { runAndReadAll, connection, db };
});

vi.mock("@duckdb/node-api", () => ({
  DuckDBInstance: { create: vi.fn(async () => duckdb.db) },
}));

import { execute } from "../services/executor/src/engine.js";

const result = (rows: Record<string, unknown>[]) => ({
  getRowObjectsJson: () => rows,
});

beforeEach(() => {
  duckdb.runAndReadAll.mockReset();
  duckdb.connection.run.mockReset();
  duckdb.runAndReadAll.mockImplementation(async (sql: string) => {
    if (sql === "SELECT count(*) n FROM result") return result([{ n: "2" }]);
    if (sql === "DESCRIBE result")
      return result([{ column_name: "id", column_type: "VARCHAR" }]);
    if (sql.startsWith("SELECT * FROM result LIMIT"))
      return result([{ id: "a" }, { id: "b" }]);
    if (sql.includes("row_hashes") && sql.includes("count(DISTINCT h)"))
      throw new Error("Out of Memory Error: test pressure");
    if (sql.includes("row_hashes") && sql.includes("approx_count_distinct(h)"))
      return result([{ fingerprint: "17", unique_rows: "2" }]);
    if (sql.includes("count(DISTINCT"))
      throw new Error("Out of Memory Error: test pressure");
    if (sql.includes("approx_count_distinct"))
      return result([{ null_count: "0", distincts: "2" }]);
    throw new Error(`Unexpected query: ${sql}`);
  });
});

it("retries memory-bound profile counts approximately without claiming keys", async () => {
  const profile = (
    await execute({
      mode: "query",
      scope: "workspace",
      version: "result",
      inputs: [],
      sql: "SELECT 1 AS id",
    })
  ).profile;

  expect(profile).toMatchObject({
    rows: 2,
    duplicateRows: 0,
    approximate: true,
  });
  expect(profile.columns[0]).toMatchObject({ distinct: 2, primaryKey: false });
  expect(
    duckdb.runAndReadAll.mock.calls.some(([sql]) =>
      String(sql).includes('approx_count_distinct("id")'),
    ),
  ).toBe(true);
  expect(
    duckdb.runAndReadAll.mock.calls.some(([sql]) =>
      String(sql).includes("approx_count_distinct(h)"),
    ),
  ).toBe(true);
});

it("can start with approximate counts for a known oversized file", async () => {
  const profile = (
    await execute({
      mode: "query",
      scope: "workspace",
      version: "result",
      inputs: [],
      sql: "SELECT 1 AS id",
      approximateProfile: true,
    })
  ).profile;

  expect(profile).toMatchObject({ approximate: true });
  expect(profile.duplicateRows).toBeUndefined();
  expect(
    duckdb.runAndReadAll.mock.calls.some(([sql]) =>
      String(sql).includes("count(DISTINCT"),
    ),
  ).toBe(false);
  expect(
    duckdb.runAndReadAll.mock.calls.some(([sql]) =>
      String(sql).includes("row_hashes"),
    ),
  ).toBe(false);
});

// The approximate retries are NOT a guaranteed fallback: on a very wide table
// they can exhaust memory too. That second failure used to fail the whole
// import, which is the production failure this test pins.
it("survives a profile where the approximate retries also exhaust memory", async () => {
  duckdb.runAndReadAll.mockImplementation(async (sql: string) => {
    if (sql === "SELECT count(*) n FROM result") return result([{ n: "2" }]);
    if (sql === "DESCRIBE result")
      return result([{ column_name: "id", column_type: "VARCHAR" }]);
    if (sql.startsWith("SELECT * FROM result LIMIT"))
      return result([{ id: "a" }, { id: "b" }]);
    if (sql.includes("row_hashes") && sql.includes("count(DISTINCT h)"))
      throw new Error("Out of Memory Error: test pressure");
    if (sql.includes("row_hashes") && sql.includes("approx_count_distinct(h)"))
      return result([{ fingerprint: "17", unique_rows: "2" }]);
    // Both per-column tiers run out of memory.
    if (sql.includes("count(DISTINCT")) 
      throw new Error("Out of Memory Error: test pressure");
    if (sql.includes("approx_count_distinct"))
      throw new Error("Out of Memory Error: test pressure");
    // The last-resort streaming NULL count still answers.
    if (sql === 'SELECT count(*)-count("id") AS null_count FROM result')
      return result([{ null_count: "1" }]);
    throw new Error(`Unexpected query: ${sql}`);
  });

  const profile = (
    await execute({
      mode: "query",
      scope: "workspace",
      version: "result",
      inputs: [],
      sql: "SELECT 1 AS id",
    })
  ).profile;

  // Degraded, not failed: flagged approximate, and the NULL count still comes
  // from the streaming aggregate while distinct falls back to the sample.
  expect(profile).toMatchObject({ rows: 2, approximate: true });
  expect(profile.columns[0]).toMatchObject({
    nulls: 1,
    distinct: 2,
    primaryKey: false,
  });
  expect(
    duckdb.runAndReadAll.mock.calls.some(([sql]) =>
      String(sql).includes('count(*)-count("id") AS null_count'),
    ),
  ).toBe(true);
});

// A partitioned ingest computes a per-partition content fingerprint that packs
// every column, so a very wide table can exhaust memory there as well. Reuse is
// only a disk optimisation, so the ingest must still write the partition.
it("still writes partitions when the content fingerprint exhausts memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-fallback-"));
  try {
    await mkdir(join(dir, "incoming", "workspace"), { recursive: true });
    await writeFile(join(dir, "incoming", "workspace", "data.jsonl"), "{}\n");
    duckdb.runAndReadAll.mockImplementation(async (sql: string) => {
      if (sql === "SELECT count(*) n FROM result") return result([{ n: "3" }]);
      if (sql === "DESCRIBE result")
        return result([{ column_name: "region", column_type: "VARCHAR" }]);
      if (sql.startsWith("SELECT * FROM result LIMIT"))
        return result([{ region: "EU" }]);
      if (sql === 'SELECT DISTINCT "region"::VARCHAR AS k FROM result')
        return result([{ k: "EU" }]);
      if (sql.includes("sum(hash("))
        throw new Error("Out of Memory Error: test pressure");
      if (sql.startsWith('SELECT count(*) n FROM result WHERE'))
        return result([{ n: "3" }]);
      if (sql.includes("count(DISTINCT"))
        throw new Error("Out of Memory Error: test pressure");
      if (sql.includes("approx_count_distinct"))
        return result([{ null_count: "0", distincts: "1" }]);
      if (sql.includes("row_hashes") && sql.includes("approx_count_distinct(h)"))
        return result([{ fingerprint: "17", unique_rows: "3" }]);
      if (sql.includes("row_hashes"))
        throw new Error("Out of Memory Error: test pressure");
      throw new Error(`Unexpected query: ${sql}`);
    });
    // The mocked connection still has to leave a real file behind for the
    // manifest's `size`.
    duckdb.connection.run.mockImplementation(async (sql: string) => {
      const copy = String(sql).match(/TO '(.+)' \(FORMAT PARQUET\)/);
      if (copy) await writeFile(copy[1], "parquet");
      return undefined;
    });

    const out = await execute(
      {
        mode: "ingest",
        scope: "workspace",
        version: "v1",
        file: "data.jsonl",
        partitionColumn: "region",
      },
      dir,
    );

    expect(out.partitions).toHaveLength(1);
    expect(out.partitions![0]).toMatchObject({
      key: "EU",
      rows: 3,
      fingerprint: "3:unknown",
    });
    expect(out.partitions![0].file).toMatch(/^v1\/EU-[0-9a-f]{12}\.parquet$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
