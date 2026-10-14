// Run the streaming-vs-materialize scale benchmark against the REAL executor
// (dist build) over HTTP, in both EXECUTOR_MODEs.
//
// Usage: pnpm exec tsx scripts/bench-scale.mts [case...]
//   cases: default-filter  raised-filter  raised-full  stream-filter  stream-full
//   (no args = all five, in that order)
//
// Requires the fixture from scripts/bench-scale-generate.mts:
//   $BENCH_DIR/data/datasets/benchscope/v1.parquet (+ expected.json)
// BENCH_DIR defaults to ~/meridian-bench. Prints a markdown table of
// wall time, peak process-tree RSS, peak temp-disk use and the outcome.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  console.error(
    `Missing benchmark fixture at ${pq}.\nRun: pnpm exec tsx scripts/bench-scale-generate.mts`,
  );
  process.exit(2);
}
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));

const FILTERED =
  "SELECT region, count(*) AS n, sum(amount) AS total FROM t WHERE region = 'us-east' GROUP BY region";
const FULL =
  "SELECT region, count(*) AS n, sum(amount) AS total FROM t GROUP BY region ORDER BY region";

type Case = {
  id: string;
  mode: "materialize" | "stream";
  mem: string;
  temp: string;
  sql: string;
  label: string;
};
const CASES: Case[] = [
  {
    id: "default-filter",
    mode: "materialize",
    mem: "768MB",
    temp: "2GB",
    sql: FILTERED,
    label: "materialize, production defaults (768MB / 2GB) — filtered aggregate",
  },
  {
    id: "raised-filter",
    mode: "materialize",
    mem: "16GB",
    temp: "4GB",
    sql: FILTERED,
    label: "materialize, raised (16GB / 4GB) — filtered aggregate",
  },
  {
    id: "raised-full",
    mode: "materialize",
    mem: "16GB",
    temp: "4GB",
    sql: FULL,
    label: "materialize, raised (16GB / 4GB) — full aggregate",
  },
  {
    id: "stream-filter",
    mode: "stream",
    mem: "768MB",
    temp: "2GB",
    sql: FILTERED,
    label: "stream, production defaults (768MB / 2GB) — filtered aggregate",
  },
  {
    id: "stream-full",
    mode: "stream",
    mem: "768MB",
    temp: "2GB",
    sql: FULL,
    label: "stream, production defaults (768MB / 2GB) — full aggregate",
  },
];
const wanted = new Set(process.argv.slice(2));
const todo = wanted.size ? CASES.filter((c) => wanted.has(c.id)) : CASES;
if (wanted.size && todo.length !== wanted.size)
  throw new Error(`Unknown case(s): ${[...wanted].join(",")}`);

// --- measurement helpers -------------------------------------------------
// Peak RSS (MB) of the whole process tree under rootPid (server + runner).
function treeRss(rootPid: number): number {
  const out = spawnSync("ps", ["-eo", "pid=,ppid=,rss="], {
    encoding: "utf8",
  }).stdout;
  const lines = out
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isFinite(pid) && Number.isFinite(ppid));
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of lines)
    (kids.get(ppid) || kids.set(ppid, []).get(ppid)!).push(pid);
  const want = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [ppid, list] of kids)
      if (want.has(ppid))
        for (const k of list)
          if (!want.has(k)) {
            want.add(k);
            grew = true;
          }
  }
  let total = 0;
  for (const [pid, , rss] of lines) if (want.has(pid)) total += rss;
  return Math.round(total / 1024); // KB -> MB
}
function dirMb(dir: string): number {
  if (!existsSync(dir)) return 0;
  const out = spawnSync("du", ["-sb", dir], { encoding: "utf8" }).stdout;
  return Math.round((Number(out.split("\t")[0]) || 0) / 1e6);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- one benchmark case ---------------------------------------------------
async function runCase(c: Case, port: number) {
  const tempDir = resolve(benchDir, `tmp-${c.id}`);
  const sbxDir = resolve(benchDir, "sbx");
  for (const d of [tempDir, sbxDir])
    spawnSync("rm", ["-rf", d]);
  for (const d of [tempDir, sbxDir, resolve(benchDir, "local")])
    mkdirSync(d, { recursive: true });
  const internalKey = randomBytes(16).toString("hex");
  const server: ChildProcess = spawn(
    process.execPath,
    [resolve(repoRoot, "dist/services/executor/src/server.js")],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        INTERNAL_KEY: internalKey,
        DATA_DIR: resolve(benchDir, "data"),
        LOCAL_DATA_PATH: resolve(benchDir, "local"),
        EXECUTOR_MODE: c.mode,
        EXECUTOR_HOST: "127.0.0.1",
        EXECUTOR_PORT: String(port),
        EXECUTOR_CONCURRENCY: "1",
        EXECUTOR_TIMEOUT_MS: "900000",
        DUCKDB_MEMORY: c.mem,
        DUCKDB_THREADS: "1",
        DUCKDB_TEMP_LIMIT: c.temp,
        DUCKDB_TEMP_DIR: tempDir,
        EXECUTOR_SANDBOX_ROOT: sbxDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout?.on("data", (d) => (serverLog += d));
  server.stderr?.on("data", (d) => (serverLog += d));

  let peakRss = 0,
    peakTemp = 0;
  const stopMeasure = await new Promise<boolean>(async (resolveFn) => {
    server.once("exit", () => resolveFn(true));
    for (let i = 0; i < 100; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (h.ok) return resolveFn(false);
      } catch {
        /* not up yet */
      }
      await sleep(200);
    }
    resolveFn(true);
  });
  if (stopMeasure) {
    server.kill("SIGKILL");
    return {
      id: c.id,
      label: c.label,
      ok: false,
      wall: 0,
      peakRss: 0,
      peakTemp: 0,
      error: "server did not start; " + serverLog.slice(-300),
    };
  }

  const measure = setInterval(() => {
    if (server.pid) peakRss = Math.max(peakRss, treeRss(server.pid));
    peakTemp = Math.max(
      peakTemp,
      c.mode === "stream" ? dirMb(sbxDir) : dirMb(tempDir),
    );
  }, 100);

  const t0 = Date.now();
  let body: any = null,
    status = 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalKey,
      },
      body: JSON.stringify({
        mode: "query",
        scope: "benchscope",
        version: "bench-" + c.id,
        inputs: [{ table: "t", version: "v1" }],
        sql: c.sql,
      }),
    });
    status = r.status;
    body = await r.json();
  } catch (e) {
    body = { error: String(e) };
  }
  const wall = Date.now() - t0;
  clearInterval(measure);
  if (server.pid) peakRss = Math.max(peakRss, treeRss(server.pid));
  peakTemp = Math.max(
    peakTemp,
    c.mode === "stream" ? dirMb(sbxDir) : dirMb(tempDir),
  );
  server.kill("SIGTERM");
  await sleep(300);
  server.kill("SIGKILL");

  // Sanity: compare against the ground truth written at generation time.
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  let match = "n/a";
  try {
    const near = (a: number, b: number) =>
      Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-9, 0.01);
    if (c.sql === FILTERED) {
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
            rows[i]?.region === e.region &&
            Number(rows[i]?.n) === Number(e.n) &&
            near(Number(rows[i]?.total), Number(e.total)),
        )
          ? "yes"
          : "MISMATCH";
    }
  } catch {
    match = "error";
  }
  const rawError =
    body?.error || (status >= 400 ? `HTTP ${status}` : undefined);
  const error = rawError && rawError.length > 160
    ? rawError.slice(0, 160) + "…"
    : rawError;
  return {
    id: c.id,
    label: c.label,
    ok: !error && match === "yes",
    wall,
    peakRss,
    peakTemp,
    match,
    error,
  };
}

// --- main -----------------------------------------------------------------
const results = [];
for (let i = 0; i < todo.length; i++) {
  const c = todo[i];
  console.error(`\n=== ${c.id} ===`);
  results.push(await runCase(c, 3110 + i));
}
console.error("\n| Case | Wall (s) | Peak tree RSS (MB) | Peak temp (MB) | Rows ok | Note |");
console.error("| ---- | -------: | -----------------: | -------------: | ------- | ---- |");
writeFileSync(
  resolve(benchDir, "results.json"),
  JSON.stringify({ fixture: statSync(pq).size, at: new Date().toISOString(), results }, null, 2),
);
for (const r of results)
  console.error(
    `| ${r.id} | ${(r.wall / 1000).toFixed(1)} | ${r.peakRss || "—"} | ${r.peakTemp || 0} | ${r.match ?? "—"} | ${r.error ? "FAILED: " + r.error : ""} |`,
  );
console.error(
  `\nFixture: ${pq} (${(statSync(pq).size / 1e9).toFixed(2)} GB)`,
);
