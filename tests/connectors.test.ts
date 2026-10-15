import { it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, dirname, sep } from "node:path";
import {
  discover,
  importSource,
  matchesLocalDataInclude,
} from "../apps/api/src/connectors.js";
import { config } from "../apps/api/src/config.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
it("matches configured local Parquet include globs", () => {
  expect(
    matchesLocalDataInclude("EHT/2025/object.parquet", "**/*.parquet"),
  ).toBe(true);
  expect(matchesLocalDataInclude("object.parquet", "**/*.parquet")).toBe(true);
  expect(
    matchesLocalDataInclude("EHT/object.parquet", "EHT/**/*.parquet"),
  ).toBe(true);
  expect(
    matchesLocalDataInclude("PRI/object.parquet", "EHT/**/*.parquet"),
  ).toBe(false);
  expect(matchesLocalDataInclude("EHT/object.csv", "EHT/**/*.parquet")).toBe(
    false,
  );
});
it("discovers and imports paginated REST data without forwarding credentials across origins", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (req.url === "/escape") {
      res.end(JSON.stringify({ items: [], next: "http://example.com/steal" }));
      return;
    }
    const u = new URL(req.url!, "http://localhost");
    const offset = Number(u.searchParams.get("offset") || 0);
    res.end(
      JSON.stringify({
        items: Array.from(
          { length: Math.max(0, Math.min(2, 5 - offset)) },
          (_, i) => ({ id: offset + i, label: "Unicode 東京" }),
        ),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as any).port,
    scope = "rest-" + randomUUID();
  try {
    const c = {
      url: base + "/data",
      itemsPath: "items",
      pagination: "offset",
      pageSize: 2,
      token: "test-token",
    };
    expect(((await discover("rest", c)) as any).sample).toHaveLength(2);
    const file = await importSource(scope, "rest", c);
    const lines = (
      await readFile(
        resolve(config.dataDir, "incoming", scope, file.file),
        "utf8",
      )
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(5);
    expect(seen).toContain("/data?offset=0&limit=2");
    await expect(
      importSource(scope, "rest", {
        ...c,
        url: base + "/escape",
        pagination: "next",
      }),
    ).rejects.toThrow("configured origin");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(resolve(config.dataDir, "incoming", scope), {
      recursive: true,
      force: true,
    });
  }
});
it("speaks S3-compatible list and streamed object protocols", async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes("list-type=2")) {
      res.setHeader("content-type", "application/xml");
      res.end(
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>fixture</Name><IsTruncated>false</IsTruncated><Contents><Key>rows.csv</Key><Size>14</Size></Contents></ListBucketResult>',
      );
    } else {
      res.setHeader("content-type", "text/csv");
      res.end("id,name\n1,Ada\n");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const scope = "s3-" + randomUUID(),
    c = {
      endpoint: "http://127.0.0.1:" + (server.address() as any).port,
      bucket: "fixture",
      key: "rows.csv",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
    };
  try {
    const found = await discover("s3", c);
    expect(found.tables).toEqual([{ name: "rows.csv", size: 14 }]);
    const result = await importSource(scope, "s3", c);
    expect(
      await readFile(
        resolve(config.dataDir, "incoming", scope, result.file),
        "utf8",
      ),
    ).toBe("id,name\n1,Ada\n");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(resolve(config.dataDir, "incoming", scope), {
      recursive: true,
      force: true,
    });
  }
});
// Placeholder bytes for a `.parquet` file. Discovery and import for the local
// connector only stat the path and check the extension; they never parse the
// file here. Content validation happens later in the DuckDB executor, which the
// engine tests exercise with a real Parquet file.
const parquetFixture = Buffer.from("not-a-real-parquet", "utf8");
it("discovers local Parquet files recursively and rejects path traversal", async () => {
  const scope = "local-" + randomUUID();
  const dir = mkdtempSync(resolve(os.tmpdir(), "foundry-local-"));
  const previous = config.localDataPath;
  config.localDataPath = dir;
  try {
    // Write fixture parquet files
    await writeFile(resolve(dir, "people.parquet"), parquetFixture);
    await mkdir(resolve(dir, "sub"), { recursive: true });
    await writeFile(resolve(dir, "sub", "nested.parquet"), parquetFixture);
    // A 0-byte placeholder: real Parquet needs magic bytes and a footer, so
    // this can never be imported. It must not become a table at all.
    await writeFile(resolve(dir, "empty.parquet"), "");

    // Escape file outside the root for traversal testing
    const escape = resolve(dirname(dir), "escape.parquet");
    await writeFile(escape, "x");

    const found = await discover("local", {});
    expect(found.tables).toHaveLength(2);
    expect(found.tables).toEqual(
      expect.arrayContaining([
        { name: "people.parquet", size: expect.any(Number) },
        { name: "sub" + sep + "nested.parquet", size: expect.any(Number) },
      ]),
    );
    const names = (found.tables as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("empty.parquet");

    const imported = await importSource(scope, "local", {
      key: "people.parquet",
    });
    expect(imported.file).toBe("");
    expect(imported.sourcePath).toBe("people.parquet");
    expect(imported.sourceFingerprint).toMatchObject({
      size: parquetFixture.length,
      mtimeMs: expect.any(Number),
    });
    await expect(
      stat(resolve(config.dataDir, "incoming", scope)),
    ).rejects.toThrow();

    // Traversal is rejected
    await expect(discover("local", { prefix: ".." + sep })).rejects.toThrow(
      "within the local data path",
    );

    await expect(
      importSource(scope, "local", { key: ".." + sep + "escape.parquet" }),
    ).rejects.toThrow("within the local data path");

    // An explicit import of the empty placeholder is refused with a clear
    // message rather than failing later inside DuckDB.
    await expect(
      importSource(scope, "local", { key: "empty.parquet" }),
    ).rejects.toThrow("empty");
  } finally {
    config.localDataPath = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(resolve(config.dataDir, "incoming", scope), {
      recursive: true,
      force: true,
    });
    await rm(dirname(dir) + sep + "escape.parquet", { force: true });
  }
});
