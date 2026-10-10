import "dotenv/config";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
const app = Fastify({ bodyLimit: 1024 * 1024, logger: true });
let active = 0;
const concurrency = Math.max(
  1,
  Math.min(4, Math.floor(Number(process.env.EXECUTOR_CONCURRENCY) || 1)),
);
const waiters: (() => void)[] = [];
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
  while (active >= concurrency) {
    if (waiters.length >= 50)
      return reply.code(429).send({ error: "Executor queue is full" });
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./runner.ts", import.meta.url)),
        ],
        {
          env: {
            PATH: process.env.PATH,
            DATA_DIR: process.env.DATA_DIR || ".data",
            DUCKDB_MEMORY: process.env.DUCKDB_MEMORY || "512MB",
            DUCKDB_THREADS: process.env.DUCKDB_THREADS || "1",
            DUCKDB_TEMP_LIMIT: process.env.DUCKDB_TEMP_LIMIT || "2GB",
            DUCKDB_TEMP_DIR: process.env.DUCKDB_TEMP_DIR || "/tmp",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      // Large snapshots profile slower than the old hardcoded two minutes.
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        Number(process.env.EXECUTOR_TIMEOUT_MS || 120000),
      );
      child.stdout.on("data", (x) => {
        out += x;
        if (out.length > 10_000_000) child.kill("SIGKILL");
      });
      child.stderr.on("data", (x) => (err += x));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(reply.code(500).send({ error: e.message }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
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
      child.stdin.end(JSON.stringify(req.body));
    });
  } finally {
    active--;
    waiters.shift()?.();
  }
});
await app.listen({
  port: Number(process.env.EXECUTOR_PORT || 3002),
  host: process.env.EXECUTOR_HOST || "127.0.0.1",
});
