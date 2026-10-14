import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { rm, writeFile, stat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execute as localExecute } from "../services/executor/src/engine.js";
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => localExecute(job),
}));
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore } from "../apps/api/src/store.js";
import { config } from "../apps/api/src/config.js";
import { ingestFile } from "../apps/api/src/datasets.js";

let store: MemoryStore;
let app: Awaited<ReturnType<typeof createApp>>;
let scope: string;

beforeEach(async () => {
  store = new MemoryStore();
  app = await createApp(store);
  await app.ready();
  const r = await app.inject({ method: "GET", url: "/api/v1/me" });
  scope = r.json().workspaces[0].id;
});

afterEach(async () => {
  await app.close();
  for (const d of ["incoming", "datasets"])
    await rm(resolve(config.dataDir, d, scope), {
      recursive: true,
      force: true,
    });
});

const CSV1 = "id,region,amount\n1,EU,10\n2,EU,20\n3,US,30\n4,AP,40\n";
// Same as CSV1 except the US row's amount changes (30 -> 300).
const CSV3 = "id,region,amount\n1,EU,10\n2,EU,20\n3,US,300\n4,AP,40\n";

const partPath = (file: string) =>
  resolve(config.dataDir, "datasets", scope, file);

it("re-ingesting a partitioned dataset reuses unchanged partition files", async () => {
  const dir = resolve(config.dataDir, "incoming", scope);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "v1.csv"), CSV1);

  // First ingest: fresh partitioned version with content fingerprints.
  const d1 = await ingestFile(store, scope, "Sales", "v1.csv", undefined, undefined, undefined, {
    partitionColumn: "region",
  });
  const v1 = (await store.get(scope, d1.data.activeVersion))!;
  const fp1: Record<string, string> = {};
  const ino1: Record<string, number> = {};
  for (const p of v1.data.partitions) {
    expect(p.fingerprint, "first version records a fingerprint").toBeTruthy();
    fp1[p.key] = p.fingerprint;
    ino1[p.key] = (await stat(partPath(p.file))).ino;
  }

  // Re-ingest with IDENTICAL content: every partition is reused (same inode)
  // and keeps its fingerprint.
  await writeFile(resolve(dir, "v2.csv"), CSV1);
  const d2 = await ingestFile(store, scope, "Sales", "v2.csv", undefined, d1.id, undefined, {
    partitionColumn: "region",
  });
  const v2 = (await store.get(scope, d2.data.activeVersion))!;
  expect(v2.data.partitions).toHaveLength(3);
  for (const p of v2.data.partitions) {
    expect(p.fingerprint).toBe(fp1[p.key]);
    expect((await stat(partPath(p.file))).ino, "unchanged partition is reused").toBe(
      ino1[p.key],
    );
  }

  // Re-ingest with ONE partition changed: that partition is rewritten (new
  // fingerprint + new inode); the others are still reused.
  await writeFile(resolve(dir, "v3.csv"), CSV3);
  const d3 = await ingestFile(store, scope, "Sales", "v3.csv", undefined, d1.id, undefined, {
    partitionColumn: "region",
  });
  const v3 = (await store.get(scope, d3.data.activeVersion))!;
  for (const p of v3.data.partitions) {
    if (p.key === "US") {
      expect(p.fingerprint, "changed partition gets a new fingerprint").not.toBe(
        fp1["US"],
      );
      expect(
        (await stat(partPath(p.file))).ino,
        "changed partition is rewritten",
      ).not.toBe(ino1["US"]);
    } else {
      expect(p.fingerprint, "unchanged partition keeps fingerprint").toBe(
        fp1[p.key],
      );
      expect(
        (await stat(partPath(p.file))).ino,
        "unchanged partition is reused",
      ).toBe(ino1[p.key]);
    }
  }
});
