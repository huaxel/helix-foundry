// Security / escape suite for the STREAMING executor sandbox (L2).
//
// The streaming path runs each query inside a per-job user+mount namespace that
// bind-mounts only the job's authorized Parquet files and masks the data roots +
// system config. This suite drives the REAL server (server.ts -> unshare -> runner
// -> engine stream mode) and asserts that every escape attempt leaks NO data.
//
// Gated: TEST_EXECUTOR_SANDBOX=1 pnpm test (it spawns a server subprocess and
// needs the host to allow user namespaces). Skips cleanly if userns is unavailable.
//
// Design rule this enforces: assert on LEAKED DATA (canary strings), not just
// "did it throw" — a masked path can return 0 rows without an error.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

// Single-quote a value for embedding in SQL (keeps SQL as plain strings).
const q = (s: string) => "'" + s + "'";

const usernsOk = (() => {
  try {
    return spawnSync("unshare", ["-rm", "true"]).status === 0;
  } catch {
    return false;
  }
})();

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

describe.skipIf(!process.env.TEST_EXECUTOR_SANDBOX || !usernsOk)(
  "streaming executor sandbox — escape tests (TEST_EXECUTOR_SANDBOX=1)",
  () => {
    let dir: string = "",
      localRoot: string = "",
      key: string = "",
      port: number = 0,
      server: ChildProcess | undefined;
    const scopeCanary = "SCOPE_CANARY_" + randomUUID();
    const scope = "testscope";

    const post = (path: string, body?: string) =>
      new Promise<{ status: number; body: string }>((res, rej) => {
        const r = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: body ? "POST" : "GET",
            headers: {
              "content-type": "application/json",
              "x-internal-key": key,
              "content-length": body ? Buffer.byteLength(body) : 0,
            },
          },
          (resp) => {
            let b = "";
            resp.on("data", (c) => (b += c));
            resp.on("end", () => res({ status: resp.statusCode ?? 0, body: b }));
          },
        );
        r.on("error", rej);
        if (body) r.write(body);
        r.end();
      });
    const query = (sql: string, extra: Record<string, unknown> = {}) =>
      post(
        "/execute",
        JSON.stringify({
          mode: "query",
          scope,
          version: "v1",
          limit: 100,
          inputs: [{ table: "d", version: "v1" }],
          sql,
          ...extra,
        }),
      );

    beforeAll(async () => {
      dir = await mkdtemp(join(os.tmpdir(), "foundry-sbx-"));
      localRoot = await mkdtemp(join(os.tmpdir(), "foundry-sbx-mnt-"));
      key = "sbx-test-internal-key-0123456789ab";
      const v1Path = join(dir, "datasets", scope, "v1.parquet");
      const secretPath = join(dir, "datasets", "OTHERSCOPE", "secret.parquet");
      await mkdir(join(dir, "datasets", scope), { recursive: true });
      await mkdir(join(dir, "datasets", "OTHERSCOPE"), { recursive: true });
      // authorized snapshot + a decoy in another scope carrying a canary
      {
        const d = await DuckDBInstance.create(":memory:", { threads: "2" });
        const c = await d.connect();
        await c.run(
          "CREATE TABLE t AS SELECT range::INT id, (range % 4)::INT grp FROM range(0, 10000)",
        );
        await c.run("COPY t TO " + q(v1Path) + " (FORMAT PARQUET)");
        await c.run(
          "COPY (SELECT " +
            q(scopeCanary) +
            " AS leak FROM range(0, 5)) TO " +
            q(secretPath) +
            " (FORMAT PARQUET)",
        );
        // Partition files for the file-list (partition) tests: two partitions of
        // one dataset, each holding a distinct region.
        await mkdir(join(dir, "datasets", scope, "partv"), { recursive: true });
        await c.run(
          "COPY (SELECT range::INT id, 'EU' AS region FROM range(0, 100)) TO " +
            q(join(dir, "datasets", scope, "partv", "eu.parquet")) +
            " (FORMAT PARQUET)",
        );
        await c.run(
          "COPY (SELECT range::INT id, 'US' AS region FROM range(0, 50)) TO " +
            q(join(dir, "datasets", scope, "partv", "us.parquet")) +
            " (FORMAT PARQUET)",
        );
        c.closeSync();
        d.closeSync();
      }
      port = await freePort();
      server = spawn(
        process.execPath,
        ["--import", "tsx", "services/executor/src/server.ts"],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            EXECUTOR_MODE: "stream",
            INTERNAL_KEY: key,
            DATA_DIR: dir,
            LOCAL_DATA_PATH: localRoot,
            EXECUTOR_HOST: "127.0.0.1",
            EXECUTOR_PORT: String(port),
            DUCKDB_THREADS: "2",
            DUCKDB_MEMORY: "1GB",
            EXECUTOR_TIMEOUT_MS: "30000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      server.stderr?.on("data", () => {});
      server.stdout?.on("data", () => {});
      let up = false;
      for (let i = 0; i < 80; i++) {
        try {
          if ((await post("/health")).status === 200) {
            up = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(up, "streaming executor server did not come up").toBe(true);
    }, 60000);

    afterAll(async () => {
      server?.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
      await rm(localRoot, { recursive: true, force: true });
    });

    it("allows the authorized snapshot (sanity)", async () => {
      const r = await query(
        "SELECT grp, count(*) n FROM d GROUP BY grp ORDER BY grp",
      );
      expect(r.status).toBe(200);
      const j = JSON.parse(r.body);
      expect(j.profile.rows).toBe(4);
      expect(j.rows).toHaveLength(4);
    });

    it("reads a partition file list as one table (stream mode)", async () => {
      const r = await post(
        "/execute",
        JSON.stringify({
          mode: "query",
          scope,
          version: "partq",
          limit: 100,
          inputs: [
            {
              table: "p",
              version: "partv",
              files: ["partv/eu.parquet", "partv/us.parquet"],
            },
          ],
          sql: "SELECT region, count(*) n FROM p GROUP BY region ORDER BY region",
        }),
      );
      expect(r.status).toBe(200);
      const j = JSON.parse(r.body);
      expect(j.rows).toEqual([
        { region: "EU", n: "100" },
        { region: "US", n: "50" },
      ]);
    });

    it("binds and reads only the listed partitions (stream mode)", async () => {
      const r = await post(
        "/execute",
        JSON.stringify({
          mode: "query",
          scope,
          version: "partq2",
          limit: 100,
          inputs: [{ table: "p", version: "partv", files: ["partv/us.parquet"] }],
          sql: "SELECT region, count(*) n FROM p GROUP BY region ORDER BY region",
        }),
      );
      expect(r.status).toBe(200);
      const j = JSON.parse(r.body);
      // Only the US partition is bound, so EU is absent.
      expect(j.rows).toEqual([{ region: "US", n: "50" }]);
    });

    it("blocks reading another scope's Parquet (no canary leak)", async () => {
      const r = await query(
        "SELECT * FROM read_parquet(" + q(secretPathOf()) + ")",
      );
      expect(r.body).not.toContain(scopeCanary);
      expect([422, 200]).toContain(r.status);
    });

    it("blocks reading a host file (no hostname leak)", async () => {
      const r = await query("SELECT * FROM read_text('/etc/hostname')");
      expect(r.body).not.toContain(os.hostname());
    });

    it("blocks writing outside the sandbox (COPY TO a masked path)", async () => {
      const target = join(dir, "evil-canary.csv");
      const r = await query("COPY (SELECT 1 AS x) TO " + q(target));
      let exists = false;
      try {
        await access(target);
        exists = true;
      } catch {}
      expect(exists).toBe(false);
      expect(r.status).toBe(422);
    });

    it("rejects an absolute sourcePath (path escape)", async () => {
      const r = await query("SELECT 1", {
        inputs: [
          {
            table: "e",
            version: "v1",
            sourcePath: "/etc/hostname",
            sourceFingerprint: { size: 1, mtimeMs: 1 },
          },
        ],
      });
      expect(r.status).toBe(422);
      expect(r.body).not.toContain(os.hostname());
    });

    it("rejects a relative sourcePath that traverses out of the root", async () => {
      const r = await query("SELECT 1", {
        inputs: [
          {
            table: "e",
            version: "v1",
            sourcePath: "../../etc/hostname",
            sourceFingerprint: { size: 1, mtimeMs: 1 },
          },
        ],
      });
      expect(r.status).toBe(422);
      expect(r.body).not.toContain(os.hostname());
    });

    it("rejects a symlink that points out of the source root", async () => {
      const canaryFile = join(dir, "outside-canary.txt");
      const canaryVal = "SYMLINK_CANARY_" + randomUUID();
      await writeFile(canaryFile, canaryVal);
      await symlink(canaryFile, join(localRoot, "evil.parquet")).catch(
        () => {},
      );
      const r = await query("SELECT 1", {
        inputs: [
          {
            table: "e",
            version: "v1",
            sourcePath: "evil.parquet",
            sourceFingerprint: { size: 1, mtimeMs: 1 },
          },
        ],
      });
      expect(r.status).toBe(422);
      expect(r.body).not.toContain(canaryVal);
    });

    // secretPath is computed from the (test-scoped) dir; helper keeps the SQL
    // lines readable.
    function secretPathOf(): string {
      return join(dir, "datasets", "OTHERSCOPE", "secret.parquet");
    }
  },
);
