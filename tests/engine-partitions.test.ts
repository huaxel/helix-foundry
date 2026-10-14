import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../services/executor/src/engine.js";

let dir: string;

// Three partitions of one dataset, split by `region`: each partition file holds
// rows for exactly one region, so pruning by region is observable from which
// files a query lists.
const PARTITIONS: { file: string; region: string }[] = [
  { file: "partv/eu.parquet", region: "EU" },
  { file: "partv/us.parquet", region: "US" },
  { file: "partv/ap.parquet", region: "AP" },
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-partitions-"));
  await mkdir(join(dir, "datasets", "a"), { recursive: true });
  // A staged source to split by `region` in the ingestion test.
  await mkdir(join(dir, "incoming", "a"), { recursive: true });
  await writeFile(
    join(dir, "incoming", "a", "data.jsonl"),
    [
      { id: 1, region: "EU", amount: 10 },
      { id: 2, region: "EU", amount: 20 },
      { id: 3, region: "US", amount: 30 },
      { id: 4, region: "AP", amount: 40 },
      { id: 5, region: "AP", amount: 50 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  const fixture = await DuckDBInstance.create(":memory:");
  const connection = await fixture.connect();
  try {
    for (const p of PARTITIONS) {
      const path = join(dir, "datasets", "a", p.file);
      await mkdir(join(dir, "datasets", "a", "partv"), { recursive: true });
      await connection.run(
        `COPY (SELECT (range + 1) id, '${p.region}' region, (range * 10) amount FROM range(0,3)) TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET)`,
      );
    }
  } finally {
    connection.closeSync();
    fixture.closeSync();
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("partitioned input (file-list union) in the engine", () => {
  it("reads a set of partition files as one logical table", async () => {
    const r = await execute(
      {
        mode: "query",
        scope: "a",
        version: "all",
        inputs: [
          {
            table: "sales",
            version: "partv",
            files: PARTITIONS.map((p) => p.file),
          },
        ],
        sql: "SELECT region, count(*) n FROM sales GROUP BY region ORDER BY region",
      },
      dir,
    );
    expect(r.rows).toEqual([
      { region: "AP", n: "3" },
      { region: "EU", n: "3" },
      { region: "US", n: "3" },
    ]);
  });

  it("reads only the files it is given (2 of 3 partitions)", async () => {
    const r = await execute(
      {
        mode: "query",
        scope: "a",
        version: "two",
        inputs: [
          {
            table: "sales",
            version: "partv",
            files: ["partv/eu.parquet", "partv/us.parquet"],
          },
        ],
        sql: "SELECT region, sum(amount) total FROM sales GROUP BY region ORDER BY region",
      },
      dir,
    );
    // AP is not in the file list, so it is absent from the result.
    expect(r.rows).toEqual([
      { region: "EU", total: "30" },
      { region: "US", total: "30" },
    ]);
  });

  it("treats a one-file set like a single snapshot", async () => {
    const r = await execute(
      {
        mode: "query",
        scope: "a",
        version: "one",
        inputs: [
          { table: "sales", version: "partv", files: ["partv/ap.parquet"] },
        ],
        sql: "SELECT count(*) n FROM sales",
      },
      dir,
    );
    expect(r.rows).toEqual([{ n: "3" }]);
  });

  it("combines input filters with a partition file list", async () => {
    const r = await execute(
      {
        mode: "query",
        scope: "a",
        version: "filtered",
        inputs: [
          {
            table: "sales",
            version: "partv",
            files: PARTITIONS.map((p) => p.file),
            filters: [{ column: "region", value: "EU" }],
          },
        ],
        sql: "SELECT count(*) n FROM sales",
      },
      dir,
    );
    expect(r.rows).toEqual([{ n: "3" }]);
  });

  it("rejects a partition file that escapes the scope dir", async () => {
    await expect(
      execute(
        {
          mode: "query",
          scope: "a",
          version: "escape",
          inputs: [
            {
              table: "sales",
              version: "partv",
              files: ["../outside.parquet"],
            },
          ],
          sql: "SELECT count(*) n FROM sales",
        },
        dir,
      ),
    ).rejects.toThrow("Invalid partition file");
  });
});

describe("partitioned ingestion (split a source by a column)", () => {
  it("writes one Parquet per distinct value and returns a manifest", async () => {
    const r = await execute(
      {
        mode: "ingest",
        scope: "a",
        version: "partingest",
        file: "data.jsonl",
        partitionColumn: "region",
      },
      dir,
    );
    expect(r.profile.rows).toBe(5);
    expect(r.partitions).toBeDefined();
    const byKey = Object.fromEntries(
      (r.partitions || []).map((p) => [p.key, p]),
    );
    // One partition per region, with the right row counts.
    expect(byKey["EU"]?.rows).toBe(2);
    expect(byKey["US"]?.rows).toBe(1);
    expect(byKey["AP"]?.rows).toBe(2);
    // The files exist on disk under datasets/<scope>/<version>/.
    for (const p of r.partitions!) {
      expect(p.file).toBe("partingest/" + p.file.split("/").pop());
      await expect(
        stat(join(dir, "datasets", "a", p.file)),
      ).resolves.toBeDefined();
    }
  });

  it("a query over the ingested manifest unions all partitions", async () => {
    const ingested = await execute(
      {
        mode: "ingest",
        scope: "a",
        version: "partingest2",
        file: "data.jsonl",
        partitionColumn: "region",
      },
      dir,
    );
    const q = await execute(
      {
        mode: "query",
        scope: "a",
        version: "q",
        inputs: [
          {
            table: "sales",
            version: "partingest2",
            files: (ingested.partitions || []).map((p) => p.file),
          },
        ],
        sql: "SELECT region, sum(amount) total FROM sales GROUP BY region ORDER BY region",
      },
      dir,
    );
    expect(q.rows).toEqual([
      { region: "AP", total: "90" },
      { region: "EU", total: "30" },
      { region: "US", total: "30" },
    ]);
  });

  it("a pruned file list opens only the selected partitions", async () => {
    const ingested = await execute(
      {
        mode: "ingest",
        scope: "a",
        version: "partingest3",
        file: "data.jsonl",
        partitionColumn: "region",
      },
      dir,
    );
    const euFiles = (ingested.partitions || [])
      .filter((p) => p.key === "EU")
      .map((p) => p.file);
    expect(euFiles).toHaveLength(1);
    const q = await execute(
      {
        mode: "query",
        scope: "a",
        version: "q2",
        inputs: [{ table: "sales", version: "partingest3", files: euFiles }],
        sql: "SELECT region, count(*) n FROM sales GROUP BY region",
      },
      dir,
    );
    // Only the EU partition is opened, so only EU rows appear.
    expect(q.rows).toEqual([{ region: "EU", n: "2" }]);
  });
});
