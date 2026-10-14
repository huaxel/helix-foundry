// Generate a realistic, non-pathologically-compressed multi-GB Parquet for
// the scale benchmark (scripts/bench-scale.mts run). High-entropy hex columns
// keep the file near its raw size, so the number is a real multi-GB file.
//
// Usage: pnpm exec tsx scripts/bench-scale-generate.mts [rows]
// Output: $BENCH_DIR/data/datasets/benchscope/v1.parquet + region counts sidecar
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rows = Number(process.argv[2] || 13_000_000);
const benchDir =
  process.env.BENCH_DIR || resolve(process.env.HOME || ".", "meridian-bench");
const out = resolve(
  benchDir,
  "data",
  "datasets",
  "benchscope",
  "v1.parquet",
);
mkdirSync(resolve(benchDir, "data", "datasets", "benchscope"), {
  recursive: true,
});
const regions = [
  "us-east",
  "us-west",
  "eu-central",
  "eu-west",
  "ap-south",
  "ap-northeast",
  "sa-east",
  "me-central",
  "ca-central",
  "af-north",
  "ap-southeast",
  "eu-north",
];
const regionList = "[" + regions.map((r) => `'${r}'`).join(",") + "]";

const db = await DuckDBInstance.create();
const c = await db.connect();
await c.run("SET threads = 8");
await c.run("SET memory_limit = '6GB'");

const t0 = Date.now();
console.log(`Generating ${rows} rows -> ${out}`);
await c.run(
  `COPY (
     SELECT
       i AS id,
       hash(i::VARCHAR) % 100000 AS account_id,
       ${regionList}[1 + (hash(i::VARCHAR || 'r') % 12)::BIGINT] AS region,
       md5(i::VARCHAR) AS name,
       md5(i::VARCHAR || '@') AS email,
       (hash(i::VARCHAR || '$') % 10000000000) / 10000.0 AS amount,
       random() AS score,
       TIMESTAMP '2024-01-01'
         + ((hash(i::VARCHAR || 't') % 730)::BIGINT * INTERVAL 1 DAY)
         + ((hash(i::VARCHAR || 's') % 86400)::BIGINT * INTERVAL 1 SECOND) AS ts,
       sha256(i::VARCHAR) || sha256(i::VARCHAR || '|') AS note
     FROM range(${rows}) t(i)
   ) TO '${out}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
);
console.log(`Wrote in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Expected per-region counts (independent ground truth for the run harness).
const agg = await c.runAndReadAll(
  `SELECT region, count(*) AS n, sum(amount) AS total
   FROM read_parquet('${out}') GROUP BY region ORDER BY region`,
);
const expected = agg.getRowObjectsJson() as any[];
writeFileSync(
  resolve(benchDir, "data", "datasets", "benchscope", "expected.json"),
  JSON.stringify({ rows, generatedAt: new Date().toISOString(), expected }, null, 2),
);
for (const r of expected)
  console.log(
    `  ${r.region}: n=${r.n} total=${Number(r.total).toFixed(2)}`,
  );
const stat = statSync(out);
console.log(`Parquet size: ${(stat.size / 1e9).toFixed(2)} GB`);
