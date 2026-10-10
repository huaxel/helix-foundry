import { beforeEach, expect, it, vi } from "vitest";

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
