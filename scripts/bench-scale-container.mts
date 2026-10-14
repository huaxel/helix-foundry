// Drive the in-CONTAINER streaming executor with the multi-GB benchmark
// queries. Unlike scripts/bench-scale.mts (which spawns a host process), this
// assumes the executor already runs inside the disposable Docker container and
// talks to it over HTTP. Wall time + result correctness are reported here;
// in-container CPU/memory are sampled separately with `docker stats`.
//
// Usage:
//   BENCH_EXECUTOR_URL=http://127.0.0.1:3902 \
//   BENCH_EXECUTOR_KEY=<internal key> \
//     pnpm exec tsx scripts/bench-scale-container.mts
//
// Requires the fixture from scripts/bench-scale-generate.mts (BENCH_DIR,
// default ~/meridian-bench): data/datasets/benchscope/v1.parquet + expected.json.
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.BENCH_EXECUTOR_URL;
const key = process.env.BENCH_EXECUTOR_KEY;
if (!url || !key) {
  console.error(
    "Set BENCH_EXECUTOR_URL (e.g. http://127.0.0.1:3902) and BENCH_EXECUTOR_KEY.",
  );
  process.exit(2);
}
const benchDir =
  process.env.BENCH_DIR || resolve(process.env.HOME || ".", "meridian-bench");
const pq = resolve(benchDir, "data", "datasets", "benchscope", "v1.parquet");
const expectedPath = resolve(
  benchDir,
  "data",
  "datasets",
  "benchscope",
  "expected.json",
);
if (!existsSync(pq) || !existsSync(expectedPath)) {
  console.error(`Missing fixture at ${pq}. Run scripts/bench-scale-generate.mts first.`);
  process.exit(2);
}
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));

const FILTERED =
  "SELECT region, count(*) AS n, sum(amount) AS total FROM t WHERE region = 'us-east' GROUP BY region";
const FULL =
  "SELECT region, count(*) AS n, sum(amount) AS total FROM t GROUP BY region ORDER BY region";

const run = async (id: string, sql: string) => {
  const t0 = Date.now();
  let status = 0;
  let body: any = null;
  try {
    const r = await fetch(url + "/execute", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": key },
      body: JSON.stringify({
        mode: "query",
        scope: "benchscope",
        version: "bench-" + id,
        inputs: [{ table: "t", version: "v1" }],
        sql,
      }),
    });
    status = r.status;
    body = await r.json();
  } catch (e) {
    body = { error: String(e) };
  }
  const wall = Date.now() - t0;

  const rows = Array.isArray(body?.rows) ? body.rows : [];
  let match = "n/a";
  try {
    const near = (a: number, b: number) =>
      Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-9, 0.01);
    if (sql === FILTERED) {
      const exp = expected.expected.find((r: any) => r.region === "us-east");
      match =
        rows.length === 1 &&
        Number(rows[0].n) === Number(exp.n) &&
        near(Number(rows[0].total), Number(exp.total))
          ? "yes"
          : `MISMATCH (got n=${rows[0]?.n} total=${rows[0]?.total}; want n=${exp.n} total=${exp.total})`;
    } else {
      match =
        rows.length === expected.expected.length &&
        expected.expected.every(
          (e: any, i: number) =>
            rows[i]?.region === e.region && Number(rows[i]?.n) === Number(e.n),
        )
          ? "yes"
          : "MISMATCH";
    }
  } catch {
    match = "error";
  }
  const err = body?.error || (status >= 400 ? `HTTP ${status}` : undefined);
  console.error(
    `| ${id} | ${status} | ${(wall / 1000).toFixed(1)} | ${match} | ${err ? String(err).slice(0, 200) : ""} |`,
  );
  return { id, status, wall, match, err };
};

// warm the container's namespace + first read, then measure
async function main() {
  const h = await fetch(url + "/health");
  if (!h.ok) throw new Error("executor /health not ok: " + (await h.text()));
  console.error("executor healthy at " + url);
  console.error(
    "\n| Case | HTTP | Wall (s) | Rows ok | Note |  (in-container CPU/mem: see docker stats)",
  );
  console.error("| ---- | ----: | -------: | ------- | ---- |");
  await run("stream-filter", FILTERED);
  await run("stream-full", FULL);
  console.error(
    `\nFixture: ${pq} (${(statSync(pq).size / 1e9).toFixed(2)} GB)`,
  );
}
main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});
