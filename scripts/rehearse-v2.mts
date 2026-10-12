// Schema v1 → v2 upgrade rehearsal against a scratch HelixDB.
// Seeds v1-shaped nodes (no top-level status/updatedAt) + a v1 schema record,
// then runs store.init() and verifies the backfill contract:
//   - schema bumps to 2
//   - every node gains top-level status/updatedAt
//   - docs are byte-identical before and after
//   - listPage status filter / ordering / pagination / getMany work
//   - a second init() is a no-op
//   - fresh writes keep promotion working
import {
  Client,
  g,
  writeBatch,
  readBatch,
  SourcePredicate,
  Predicate,
  Order,
} from "@helix-db/helix-db";
// One-time scratch-database rehearsal of the v1 -> v2 store upgrade
// (backfill + promoted status/updatedAt properties). Point it at an
// EMPTY or disposable HelixDB: it seeds v1-shaped nodes, upgrades,
// verifies, and deletes what it seeded.
//   HELIX_URL=http://127.0.0.1:16996 pnpm exec tsx scripts/rehearse-v2.mts
// Run the v2 backfill in this script regardless of entry point (the gate
// defaults to the app's process, but the rehearsal is a one-off CLI).
process.env.HELIX_FORCE_BACKFILL = "1";
const { HelixStore, transaction, resource, now } = await import(
  "../apps/api/src/store.js"
);
import { config } from "../apps/api/src/config.js";

const client = Client.server(config.helix);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const iso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60000).toISOString();

// ---- seed v1-era data (raw writes, NO promoted properties) ----
type V1 = {
  scope: string;
  kind: string;
  name: string;
  data: Record<string, any>;
  id: string;
  updatedAt: string;
};
const seeds: V1[] = [
  {
    scope: "global",
    kind: "migration",
    name: "Initial workspace schema",
    data: { version: 1, appliedAt: iso(1000) },
    id: "schema",
    updatedAt: iso(1000),
  },
  {
    scope: "global",
    kind: "workspaceRef",
    name: "ws_test",
    data: { id: "ws_test" },
    id: "ws_test",
    updatedAt: iso(900),
  },
  {
    scope: "ws_test",
    kind: "job",
    name: "queued job",
    data: { status: "queued", sourceId: "s1", type: "sync" },
    id: "j1",
    updatedAt: iso(50),
  },
  {
    scope: "ws_test",
    kind: "job",
    name: "running job",
    data: { status: "running", sourceId: "s2", type: "pipeline", pipelineId: "p1" },
    id: "j2",
    updatedAt: iso(30),
  },
  {
    scope: "ws_test",
    kind: "job",
    name: "done job",
    data: { status: "done", sourceId: "s3", type: "upload" },
    id: "j3",
    updatedAt: iso(20),
  },
  {
    scope: "ws_test",
    kind: "job",
    name: "no-status job",
    data: { type: "upload" },
    id: "j4",
    updatedAt: iso(10),
  },
  {
    scope: "ws_test",
    kind: "run",
    name: "queued run",
    data: { status: "queued", stage: "queued" },
    id: "r1",
    updatedAt: iso(5),
  },
  {
    scope: "ws_test",
    kind: "run",
    name: "done run",
    data: { status: "done" },
    id: "r2",
    updatedAt: iso(2),
  },
];
const v1Docs = new Map<string, string>();
for (const s of seeds) {
  const doc = {
    id: s.id,
    kind: s.kind,
    name: s.name,
    data: s.data,
    workspaceId: s.scope,
    createdAt: s.updatedAt,
    updatedAt: s.updatedAt,
    revision: 1,
  };
  v1Docs.set(s.scope + ":" + s.id, JSON.stringify(doc));
  await client
    .requestBuilder()
    .shouldAwaitDurability(true)
    .query(
      writeBatch()
        .varAs(
          "n",
          g().addN("FoundryRecord", {
            key: s.scope + ":" + s.id,
            scope: s.scope,
            scopeKind: s.scope + ":" + s.kind,
            doc: v1Docs.get(s.scope + ":" + s.id)!,
          }),
        )
        .returning(["n"]).toQueryRequest(),
    )
    .send();
}
console.log("Seeded " + seeds.length + " v1-shaped nodes");

// sanity: confirm the server really has no promoted props yet
const rawBefore: any = await client
  .query(
    readBatch()
      .varAs(
        "recs",
        g()
          .nWithLabelWhere(
            "FoundryRecord",
            SourcePredicate.eq("scope", "ws_test"),
          )
          .valueMap(["status", "updatedAt"]),
      )
      .returning(["recs"]).toQueryRequest(),
  )
  .send();
check(
  "precondition: v1 nodes lack top-level status/updatedAt",
  (rawBefore.recs || []).every((x: any) => x.status === undefined),
);

// ---- run the upgrade ----
const store = new HelixStore();
const t0 = Date.now();
await store.init();
console.log(`init() (backfill) took ${Date.now() - t0}ms`);

const schema = await store.get("global", "schema");
check("schema version bumped to 2", schema?.data.version === 2);

// docs byte-identical across both scopes
const allAfter: Array<[string, string]> = [];
for (const scope of ["global", "ws_test"])
  for (const r of await store.list(scope))
    allAfter.push([scope + ":" + r.id, JSON.stringify(r)]);
const dataDocs = allAfter.filter(([k]) => k !== "global:schema");
check(
  "all " + (v1Docs.size - 1) + " data docs byte-identical after backfill",
  allAfter.length === v1Docs.size &&
    dataDocs.every(([k, doc]) => v1Docs.get(k) === doc),
  dataDocs
    .filter(([k, doc]) => v1Docs.get(k) !== doc)
    .map(([k]) => k)
    .join(","),
);
const seedSchema = JSON.parse(v1Docs.get("global:schema")!);
const newSchema = (allAfter.find(([k]) => k === "global:schema") || [])[1]
  ? JSON.parse(allAfter.find(([k]) => k === "global:schema")![1])
  : undefined;
check(
  "only change to schema record: version 2 + appliedAt + revision",
  !!newSchema &&
    newSchema.data.version === 2 &&
    newSchema.id === seedSchema.id &&
    newSchema.name === seedSchema.name &&
    newSchema.workspaceId === seedSchema.workspaceId &&
    newSchema.createdAt === seedSchema.createdAt &&
    newSchema.data.appliedAt !== seedSchema.data.appliedAt &&
    Math.abs(new Date(newSchema.updatedAt).getTime() - new Date(newSchema.data.appliedAt).getTime()) < 10000 &&
    newSchema.revision === 2,
  JSON.stringify(newSchema?.data),
);

// promoted props present and correct
const rawAfter: any = await client
  .query(
    readBatch()
      .varAs(
        "recs",
        g()
          .nWithLabelWhere(
            "FoundryRecord",
            SourcePredicate.eq("key", "ws_test:j1"),
          )
          .valueMap(["status", "updatedAt"]),
      )
      .returning(["recs"]).toQueryRequest(),
  )
  .send();
const j1 = (rawAfter.recs || [])[0] || {};
const j1doc = await store.get("ws_test", "j1");
check(
  "job node carries top-level status/updatedAt",
  j1.status === "queued" && j1.updatedAt === j1doc?.updatedAt,
  JSON.stringify(j1),
);

// listPage: status filter
const { items: active, total: activeTotal } = await store.listPage(
  "ws_test",
  "job",
  { status: ["queued", "running"] },
);
check(
  "listPage status filter exact",
  activeTotal === 2 &&
    [...active.map((r) => r.id)].sort().join(",") === "j1,j2",
  "got=" + active.map((r) => r.id).join(","),
);
// listPage: ordering newest-first with key tie-break + total ignores paging
const { items: page1, total: t1 } = await store.listPage("ws_test", "run", {
  order: { prop: "updatedAt", dir: "desc" },
  offset: 0,
  limit: 1,
});
const { items: page2 } = await store.listPage("ws_test", "run", {
  order: { prop: "updatedAt", dir: "desc" },
  offset: 1,
  limit: 1,
});
check(
  "listPage desc ordering + offset partitions exactly",
  t1 === 2 &&
    page1[0]?.id === "r2" &&
    page2[0]?.id === "r1" &&
    page1.length === 1 &&
    page2.length === 1,
  "p1=" + page1.map((r) => r.id).join(",") + " p2=" + page2.map((r) => r.id).join(","),
);
// getMany
const many = await store.getMany("ws_test", ["j1", "r1", "missing"]);
check(
  "getMany returns exactly the existing ids",
  [...many.keys()].sort().join(",") === "j1,r1" &&
    many.get("j1")?.name === "queued job",
);

// idempotent second init
const before2 = new Map(allAfter);
await new HelixStore().init();
const allAfter2: Array<[string, string]> = [];
for (const scope of ["global", "ws_test"])
  for (const r of await store.list(scope))
    allAfter2.push([scope + ":" + r.id, JSON.stringify(r)]);
check(
  "second init() is a no-op on docs",
  JSON.stringify([...allAfter2].sort()) === JSON.stringify([...before2].sort()),
);

// fresh writes still promote
await transaction(store, "ws_test", async (tx) => {
  tx.put(
    resource("ws_test", "job", "fresh", { status: "queued", sourceId: "s9" }, "j9"),
  );
});
const fresh = await store.listPage("ws_test", "job", {
  status: ["queued", "running"],
});
check(
  "post-upgrade writes are promoted (new job visible in status index)",
  fresh.items.some((r) => r.id === "j9") && fresh.total === 3,
  "total=" + fresh.total,
);

// cleanup the seeded scopes
for (const scope of ["ws_test", "global"]) {
  const rows = await store.list(scope);
  if (rows.length)
    await transaction(store, scope, async (tx) => {
      for (const r of rows) tx.delete(r.id);
    });
}
check(
  "cleanup removed seeded scopes",
  (await store.list("ws_test")).length === 0 &&
    (await store.list("global")).length === 0,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
