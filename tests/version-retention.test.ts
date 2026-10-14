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
import { ingestFile, VERSION_RETENTION } from "../apps/api/src/datasets.js";

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

const dir = () => resolve(config.dataDir, "incoming", scope);
const dsPath = (file: string) =>
  resolve(config.dataDir, "datasets", scope, file);
const csv = (extra = "") =>
  `id,region,amount${extra ? "," + extra : ""}\n1,EU,10${extra ? ",x" : ""}\n2,US,30${extra ? ",y" : ""}\n`;

it("prunes version history to the retention window, protecting active and pending versions", async () => {
  await mkdir(dir(), { recursive: true });

  // Twelve same-schema ingests, tracking each version id (newest last).
  const ids: string[] = [];
  let ds: any;
  for (let i = 0; i < 12; i++) {
    const file = `a${i}.csv`;
    await writeFile(resolve(dir(), file), csv());
    ds = await ingestFile(store, scope, "Sales", file, undefined, ds?.id, undefined, {
      partitionColumn: "region",
    });
    ds = await store.get(scope, ds.id); // post-prune state
    ids.push(ds.data.activeVersion);
  }
  const versions: string[] = ds.data.versions;
  expect(versions).toHaveLength(VERSION_RETENTION);
  expect(versions).toEqual(ids.slice().reverse().slice(0, VERSION_RETENTION));

  // The two oldest versions were dropped: resource deleted, files removed.
  for (const dropped of ids.slice(0, 2)) {
    expect(await store.get(scope, dropped)).toBeUndefined();
    await expect(stat(dsPath(dropped))).rejects.toThrow();
  }

  // The oldest RETAINED version still has its partition files on disk.
  const oldestKept = ids[2];
  const keptVer = (await store.get(scope, oldestKept))!;
  expect(keptVer).toBeTruthy();
  for (const p of keptVer.data.partitions)
    expect((await stat(dsPath(p.file))).size).toBeGreaterThan(0);

  // A schema change starts drifting: every same-new-schema ingest keeps
  // activeVersion pinned to the last good version while pendingVersion moves.
  // Ten drift ingests push that pinned activeVersion outside the retention
  // window — it (and the pending version) must survive.
  for (let i = 0; i < 10; i++) {
    const file = `b${i}.csv`;
    await writeFile(resolve(dir(), file), csv("extra"));
    ds = await ingestFile(store, scope, "Sales", file, undefined, ds.id, undefined, {
      partitionColumn: "region",
    });
    ds = await store.get(scope, ds.id); // post-prune state
  }
  expect(ds.data.pendingVersion).toBeTruthy();
  expect(ds.data.activeVersion).toBe(ids[11]);
  const drifted: string[] = ds.data.versions;
  expect(drifted).toHaveLength(VERSION_RETENTION + 1);
  expect(drifted).toContain(ds.data.activeVersion);
  expect(drifted).toContain(ds.data.pendingVersion);

  // The protected active version's files are still on disk.
  const activeVer = (await store.get(scope, ds.data.activeVersion))!;
  expect(activeVer).toBeTruthy();
  for (const p of activeVer.data.partitions)
    expect((await stat(dsPath(p.file))).size).toBeGreaterThan(0);
});
