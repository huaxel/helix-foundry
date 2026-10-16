import "dotenv/config";
import Fastify from "fastify";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, isAbsolute, sep, dirname } from "node:path";

const app = Fastify({ bodyLimit: 1024 * 1024, logger: true });
const runnerPath = fileURLToPath(new URL("./runner.js", import.meta.url));
// The app root (contains node_modules/tsx). Pin the query child's cwd here so
// the loader — tsx when the runner is TypeScript source, nothing when it is
// compiled — resolves regardless of the server's own working dir.
const appRoot = resolve(dirname(runnerPath), "..", "..", "..");

// Single-quote a path for the sandbox setup shell script.
const shq = shellQuote;

// The packaged image ships compiled JavaScript, so the child needs no TypeScript
// loader; from the source tree it does (see runner-launch.ts).
const launch = runnerLaunch(runnerPath, existsSync(runnerPath));

import { createGate } from "./gate.js";
import { runnerLaunch, shellQuote } from "./runner-launch.js";

const concurrency = Math.max(
  1,
  Math.min(4, Math.floor(Number(process.env.EXECUTOR_CONCURRENCY) || 1)),
);
// Interactive queries jump ahead of queued background (ingest/export) jobs.
const gate = createGate(concurrency);

// Stream mode wraps each job in a per-job user+mount namespace (unshare -rm).
// That needs the kernel to allow unprivileged user namespaces AND the
// container's seccomp profile to permit CLONE_NEWUSER. Probe once at boot and
// fail loudly rather than silently serve a streaming query without its boundary.
let usernsOk = false;
try {
  usernsOk = spawnSync("unshare", ["-rm", "true"]).status === 0;
} catch {
  usernsOk = false;
}
if (process.env.EXECUTOR_MODE === "stream" && !usernsOk)
  app.log.warn(
    "EXECUTOR_MODE=stream is set but this executor cannot create user namespaces. " +
      "Streaming queries will fail. Set EXECUTOR_MODE=materialize, or run the " +
      "executor container with a seccomp profile that allows CLONE_NEWUSER.",
  );

type Sandbox = { in: string[][]; tmp: string };
type Prepared = {
  enabled: boolean;
  sandbox?: Sandbox;
  setup?: string;
  dir?: string;
};

// Build the per-job mount namespace for stream mode: bind each authorized input
// file into a private dir under the sandbox root, then mask the data roots and
// system config so a query can only reach its own inputs. The sandbox root lives
// OUTSIDE the masked trees (default: a subdir of $TMPDIR), so its bind mounts
// survive the masking.
async function prepareSandbox(job: any): Promise<Prepared> {
  if (
    process.env.EXECUTOR_MODE !== "stream" ||
    job?.mode !== "query" ||
    !Array.isArray(job?.inputs) ||
    job.inputs.length === 0
  )
    return { enabled: false };
  if (!usernsOk)
    throw new Error(
      "EXECUTOR_MODE=stream needs user namespaces, but this executor cannot " +
        "create one. Set EXECUTOR_MODE=materialize, or run the executor " +
        "container with a seccomp profile that allows CLONE_NEWUSER.",
    );
  const dataDir = resolve(process.env.DATA_DIR || ".data");
  const localRoot = process.env.LOCAL_DATA_PATH || "/mnt/parquet";
  const sbxRoot = resolve(
    process.env.EXECUTOR_SANDBOX_ROOT || resolve(tmpdir(), "executor-sbx"),
  );
  await mkdir(sbxRoot, { recursive: true });
  const dir = await mkdtemp(resolve(sbxRoot, "job-"));
  const inDir = resolve(dir, "in");
  const tmp = resolve(dir, "tmp");
  const mask = resolve(dir, "mask");
  await Promise.all([mkdir(inDir), mkdir(tmp), mkdir(mask)]);

  const binds: string[] = [];
  const inPaths: string[][] = [];
  try {
    const scopeDir = resolve(dataDir, "datasets", job.scope);
    for (let i = 0; i < job.inputs.length; i++) {
      const input = job.inputs[i];
      let realFiles: string[];
      if (input.files && input.files.length) {
        // Partitioned dataset: bind one file per partition, each validated to
        // stay under this scope's dataset dir.
        realFiles = input.files.map((f: string) => {
          if (isAbsolute(f)) throw new Error("Invalid partition file");
          const real = resolve(scopeDir, f);
          if (!real.startsWith(scopeDir + sep))
            throw new Error("Invalid partition file");
          return real;
        });
        for (const real of realFiles) {
          const cur = await stat(real);
          if (!cur.isFile()) throw new Error("Partition snapshot not found");
        }
      } else if (input.sourcePath) {
        // Mounted source: same bounds + fingerprint rules as engine.resolveSource.
        if (isAbsolute(input.sourcePath))
          throw new Error("Invalid mounted source reference");
        const srcRoot = await realpath(resolve(localRoot));
        const source = await realpath(resolve(srcRoot, input.sourcePath));
        if (
          !source.startsWith(srcRoot + sep) ||
          !source.toLowerCase().endsWith(".parquet")
        )
          throw new Error(
            "Mounted source must be a Parquet file inside the configured root",
          );
        const cur = await stat(source);
        if (!cur.isFile()) throw new Error("Mounted source is not a regular file");
        const fp = input.sourceFingerprint;
        if (fp && (cur.size !== fp.size || cur.mtimeMs !== fp.mtimeMs))
          throw new Error(
            "Mounted Parquet source changed; re-import it to refresh the dataset",
          );
        realFiles = [source];
      } else {
        const real = resolve(scopeDir, input.version + ".parquet");
        const cur = await stat(real);
        if (!cur.isFile()) throw new Error("Snapshot not found");
        realFiles = [real];
      }
      const inList: string[] = [];
      for (let j = 0; j < realFiles.length; j++) {
        const inPath = resolve(inDir, i + "-" + j + ".parquet");
        await writeFile(inPath, ""); // bind target must exist before the mount
        binds.push(`mount --bind ${shq(realFiles[j])} ${shq(inPath)}`);
        inList.push(inPath);
      }
      inPaths.push(inList);
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }

  // Mask whole directory trees — never individual files (one unmasked file is a
  // leak). Only mask paths that exist and are directories, and NEVER an ancestor
  // of the app's own tree (its code + node_modules must stay reachable).
  // /proc is masked because the mount namespace shares the host PID namespace:
  // /proc/<server-pid>/environ still carries INTERNAL_KEY, and stream mode
  // leaves external access ON, so any readable path is a SQL away. /dev is
  // deliberately NOT masked (the child needs /dev/null and /dev/urandom).
  // Accepted residual: sibling job dirs under the shared sandbox root stay
  // visible — every job serves the same installation (same principal), and a
  // SQL-only attacker can read but not mount, so this is same-user data only.
  const masked: string[] = [];
  for (const p of [
    dataDir,
    localRoot,
    "/etc",
    "/root",
    "/home",
    "/sys",
    "/proc",
    "/run",
  ]) {
    if (p === appRoot || appRoot.startsWith(p + sep)) continue;
    try {
      if ((await stat(p)).isDirectory()) masked.push(p);
    } catch {
      /* not present in this environment — nothing to mask */
    }
  }
  const setup = [
    "set -e",
    ...binds,
    ...masked.map((p) => `mount --bind ${shq(mask)} ${shq(p)}`),
    launch.shell,
  ].join("\n");
  return { enabled: true, sandbox: { in: inPaths, tmp }, setup, dir };
}

app.get("/health", async () => ({ ok: true }));
app.post("/execute", async (req, reply) => {
  const key = String(req.headers["x-internal-key"] || ""),
    expected = process.env.INTERNAL_KEY || "";
  if (
    expected.length < 32 ||
    Buffer.byteLength(key) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
  )
    return reply.code(401).send({ error: "Unauthorized" });
  if ((await gate.enter((req.body as { mode?: string } | undefined)?.mode === "query")) !== "ok")
    return reply.code(429).send({ error: "Executor queue is full" });
  try {
    let prepared: Prepared = { enabled: false };
    try {
      prepared = await prepareSandbox(req.body);
    } catch (e) {
      return reply
        .code(422)
        .send({ error: e instanceof Error ? e.message : "Sandbox setup failed" });
    }
    const body = req.body as Record<string, unknown>;
    const job = prepared.enabled
      ? { ...body, sandbox: prepared.sandbox }
      : body;
    return await new Promise((resolve) => {
      // The child only ever gets PATH, DATA_DIR and DUCKDB_* — never the
      // ENCRYPTION_KEY or INTERNAL_KEY, so even /proc/<pid>/environ in the
      // namespace holds no secrets.
      const env = {
        PATH: process.env.PATH,
        DATA_DIR: process.env.DATA_DIR || ".data",
        LOCAL_DATA_PATH: process.env.LOCAL_DATA_PATH || "/mnt/parquet",
        // The child engine must see the same mode as the server so it takes the
        // stream (view + sandbox) path rather than the materialize path.
        EXECUTOR_MODE: process.env.EXECUTOR_MODE || "materialize",
        DUCKDB_MEMORY: process.env.DUCKDB_MEMORY || "512MB",
        DUCKDB_THREADS: process.env.DUCKDB_THREADS || "1",
        DUCKDB_TEMP_LIMIT: process.env.DUCKDB_TEMP_LIMIT || "2GB",
        DUCKDB_TEMP_DIR: prepared.enabled
          ? prepared.sandbox!.tmp
          : process.env.DUCKDB_TEMP_DIR || "/tmp",
      };
      // Stream: the per-job user+mount namespace IS the sandbox. Materialize:
      // the in-memory copy + DuckDB lockdown (existing behavior).
      const child = prepared.enabled
        ? spawn("unshare", ["-rm", "sh", "-c", prepared.setup!], {
            cwd: appRoot,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(process.execPath, launch.args, {
            cwd: appRoot,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
      let out = "",
        err = "";
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        Number(process.env.EXECUTOR_TIMEOUT_MS || 120000),
      );
      const cleanup = () => {
        if (prepared.enabled && prepared.dir)
          rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
      };
      child.stdout.on("data", (x) => {
        out += x;
        if (out.length > 10_000_000) child.kill("SIGKILL");
      });
      child.stderr.on("data", (x) => (err += x));
      child.on("error", (e) => {
        clearTimeout(timer);
        cleanup();
        resolve(reply.code(500).send({ error: e.message }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        cleanup();
        if (code !== 0)
          return resolve(
            reply.code(422).send({
              error: err.slice(0, 1500) || "Query exceeded execution limits",
            }),
          );
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve(reply.code(500).send({ error: "Invalid executor response" }));
        }
      });
      child.stdin.end(JSON.stringify(job));
    });
  } finally {
    gate.leave();
  }
});
await app.listen({
  port: Number(process.env.EXECUTOR_PORT || 3002),
  host: process.env.EXECUTOR_HOST || "127.0.0.1",
});
