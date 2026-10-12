import { randomUUID } from "node:crypto";
import {
  Client,
  readBatch,
  writeBatch,
  g,
  Order,
  SourcePredicate,
  Predicate,
  NodeRef,
  EdgeRef,
  BatchCondition,
  IndexSpec,
} from "@helix-db/helix-db";
import type { Resource } from "../../../packages/shared/src/index.js";
import { config } from "./config.js";
import { AppError } from "./security.js";
export const now = () => new Date().toISOString();
export function resource(
  scope: string,
  kind: string,
  name: string,
  data: Record<string, any> = {},
  id: string = randomUUID(),
): Resource {
  return {
    id,
    workspaceId: scope,
    kind,
    name,
    description: "",
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
    data,
  };
}
export type Change = { put: Resource } | { delete: string };
export interface ListPageOpts {
  // Filter by the top-level status property (promoted from data.status).
  status?: string | string[];
  // Sort by a top-level property before slicing. updatedAt is promoted on
  // every write; key orders by id within a scope.
  order?: { prop: "updatedAt" | "key"; dir: "asc" | "desc" };
  offset?: number;
  limit?: number;
}
export interface Store {
  init(): Promise<void>;
  list(scope: string, kind?: string): Promise<Resource[]>;
  listPage(
    scope: string,
    kind: string,
    opts?: ListPageOpts,
  ): Promise<{ items: Resource[]; total: number }>;
  get(scope: string, id: string): Promise<Resource | undefined>;
  getMany(scope: string, ids: string[]): Promise<Map<string, Resource>>;
  commit(scope: string, version: number, changes: Change[]): Promise<boolean>;
  version(scope: string): Promise<number>;
  neighbors(scope: string, id: string): Promise<string[]>;
}
const anchor = (key: string) =>
  g().nWithLabelWhere("FoundryRecord", SourcePredicate.eq("key", key));
export class HelixStore implements Store {
  client = Client.server(config.helix);
  async read(q: any): Promise<any> {
    return this.client.query(q.toQueryRequest()).send();
  }
  async write(q: any): Promise<any> {
    return this.client
      .requestBuilder()
      .shouldAwaitDurability(true)
      .query(q.toQueryRequest())
      .send();
  }
  async init() {
    for (const property of ["key", "scope", "scopeKind", "status"])
      await this.write(
        writeBatch()
          .varAs(
            "index",
            g().createIndexIfNotExists(
              property === "key"
                ? IndexSpec.nodeUniqueEquality("FoundryRecord", property)
                : IndexSpec.nodeEquality("FoundryRecord", property),
            ),
          )
          .returning(["index"]),
      );
    // Newest-first pagination orders by updatedAt desc; a single desc range
    // index covers it (asc+desc on one field conflict on the server).
    // Non-fatal: ordering still works unindexed if the pinned server
    // rejects the range spec; the status equality index above (proven
    // pattern) remains strict because the worker depends on it.
    try {
      await this.write(
        writeBatch()
          .varAs(
            "index",
            g().createIndexIfNotExists(
              IndexSpec.nodeRangeDesc("FoundryRecord", "updatedAt"),
            ),
          )
          .returning(["index"]),
      );
    } catch (e) {
      console.warn(
        "Range index skipped (ordering falls back to unindexed):",
        e instanceof Error ? e.message : e,
      );
    }
    const current = await this.get("global", "schema");
    if (current && current.data.version > 2)
      throw new Error(
        "Database schema is newer than this application; restore the matching release",
      );
    if (!current) {
      await transaction(this, "global", async (tx) => {
        if (!(await tx.get("schema")))
          tx.put(
            resource(
              "global",
              "migration",
              "Initial workspace schema",
              { version: 2, appliedAt: now() },
              "schema",
            ),
          );
      });
      return;
    }
    if (current.data.version < 2) {
      if (isAppProcess()) {
        // One-time v1 to v2: rewrite every node so commit promotion backfills
        // the top-level status/updatedAt properties. Uses only proven list +
        // commit patterns; docs are unchanged, revisions are not bumped.
        //
        // The app is the single owner of BOTH the backfill and the version
        // bump. init() runs before the server listens and the worker blocks
        // in the branch below, so the backfill has no concurrent writers and
        // its re-puts cannot clobber anything. (If the worker bumped the
        // version first, the app would read version 2 here and skip the
        // backfill, leaving rows un-promoted — the race this gate prevents.)
        await backfillTopLevelProps(this);
        await transaction(this, "global", async (tx) => {
          const s = await tx.get("schema");
          if (s && s.data.version < 2)
            tx.put({
              ...s,
              data: { ...s.data, version: 2, appliedAt: now() },
              revision: s.revision + 1,
              updatedAt: now(),
            });
        });
      } else {
        // Worker (or any non-app process): wait for the app to finish the
        // backfill and bump the schema to v2 before starting. Pre-upgrade
        // rows lack the promoted status/updatedAt properties until the app
        // re-writes them; starting job work earlier would read a partially
        // promoted status index. Self-heals on app restart: the backfill is
        // idempotent and re-runs until the version reaches 2.
        for (;;) {
          const s = await this.get("global", "schema");
          if (s && s.data.version >= 2) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }
  async list(scope: string, kind?: string) {
    const q = readBatch()
      .varAs(
        "records",
        g()
          .nWithLabelWhere(
            "FoundryRecord",
            SourcePredicate.eq(
              kind ? "scopeKind" : "scope",
              kind ? scope + ":" + kind : scope,
            ),
          )
          .valueMap(["doc"]),
      )
      .returning(["records"]);
    const r = await this.read(q);
    return (r.records || [])
      .filter((x: any) => x.doc)
      .map((x: any) => JSON.parse(x.doc)) as Resource[];
  }
  async get(scope: string, id: string) {
    const r = await this.read(
      readBatch()
        .varAs("records", anchor(scope + ":" + id).valueMap(["doc"]))
        .returning(["records"]),
    );
    return r.records?.[0]?.doc
      ? (JSON.parse(r.records[0].doc) as Resource)
      : undefined;
  }
  // One HelixDB batch for many ids (a single round trip), replacing per-row
  // get() loops in list paths. Returns only the ids that exist.
  async getMany(scope: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, Resource>();
    let q = readBatch();
    const names: string[] = [];
    for (const [i, id] of unique.entries()) {
      const name = "m" + i;
      names.push(name);
      q = q.varAs(name, anchor(scope + ":" + id).valueMap(["doc"]));
    }
    const r = await this.read(q.returning(names));
    const out = new Map<string, Resource>();
    for (const [i, id] of unique.entries()) {
      const doc = r[names[i]]?.[0]?.doc;
      if (doc) out.set(id, JSON.parse(doc) as Resource);
    }
    return out;
  }
  // Storage-level filtered, ordered and paged list. Status and updatedAt are
  // top-level indexed properties (see commit promotion and schema v2), so
  // the worker and plain list pages avoid full-collection scans. total is the
  // count matching kind+status, ignoring offset/limit.
  async listPage(
    scope: string,
    kind: string,
    opts: ListPageOpts = {},
  ): Promise<{ items: Resource[]; total: number }> {
    const match = g().nWithLabelWhere(
      "FoundryRecord",
      SourcePredicate.eq("scopeKind", scope + ":" + kind),
    );
    const statuses = opts.status
      ? Array.isArray(opts.status)
        ? opts.status
        : [opts.status]
      : [];
    const filtered =
      statuses.length === 0
        ? match
        : statuses.length === 1
          ? match.where(Predicate.eq("status", statuses[0]))
          : match.where(
              Predicate.or(statuses.map((s) => Predicate.eq("status", s))),
            );
    const ordered = opts.order
      ? filtered.orderByMultiple(
          // key is unique per node, so it needs no tie-break of its own
          // (the server rejects a duplicate order key).
          opts.order.prop === "key"
            ? [
                [
                  opts.order.prop,
                  opts.order.dir === "desc" ? Order.Desc : Order.Asc,
                ],
              ]
            : [
                [
                  opts.order.prop,
                  opts.order.dir === "desc" ? Order.Desc : Order.Asc,
                ],
                // Deterministic tie-break matching the route sort (id ascending).
                ["key", Order.Asc],
              ],
        )
      : filtered;
    const offset = Math.max(opts.offset || 0, 0);
    const limit =
      opts.limit === undefined
        ? undefined
        : Math.max(1, Math.min(opts.limit, 1000));
    let paged = ordered;
    if (offset) paged = paged.skip(offset);
    if (limit !== undefined) paged = paged.limit(limit);
    const [items, counted] = await Promise.all([
      this.read(
        readBatch()
          .varAs("records", paged.valueMap(["doc"]))
          .returning(["records"]),
      ),
      this.read(
        readBatch()
          .varAs("n", filtered.count())
          .returning(["n"]),
      ),
    ]);
    return {
      items: (items.records || [])
        .filter((x: any) => x.doc)
        .map((x: any) => JSON.parse(x.doc) as Resource),
      total: Number(counted.n ?? 0),
    };
  }
  async version(scope: string) {
    const r = await this.read(
      readBatch()
        .varAs("v", anchor(scope + ":__revision").valueMap(["version"]))
        .returning(["v"]),
    );
    return Number(r.v?.[0]?.version || 0);
  }
  async commit(scope: string, version: number, changes: Change[]) {
    changes = [
      ...new Map(
        changes.map((c) => ["put" in c ? c.put.id : c.delete, c]),
      ).values(),
    ];
    let existingQuery = readBatch();
    const names: string[] = [];
    for (const [i, c] of changes.entries()) {
      const name = "p" + i;
      names.push(name);
      existingQuery = existingQuery.varAs(
        name,
        anchor(scope + ":" + ("put" in c ? c.put.id : c.delete)).valueMap([
          "key",
        ]),
      );
    }
    const present = names.length
      ? await this.read(existingQuery.returning(names))
      : {};
    let q = writeBatch().varAs("clock", anchor(scope + ":__revision"));
    if (version === 0) {
      q = q.varAsIf(
        "guard",
        BatchCondition.varEmpty("clock"),
        g().addN("FoundryRecord", {
          key: scope + ":__revision",
          scope: "__clocks",
          scopeKind: "__clocks:clock",
          version: 1,
        }),
      );
    } else
      q = q.varAs(
        "guard",
        g()
          .n(NodeRef.var("clock"))
          .where(Predicate.eq("version", version))
          .setProperty("version", version + 1),
      );
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i],
        id = "put" in c ? c.put.id : c.delete;
      if ("delete" in c) {
        q = q.varAsIf(
          "de" + i,
          BatchCondition.varNotEmpty("guard"),
          g()
            .eWithLabelWhere(
              "FoundryRelationship",
              SourcePredicate.eq("relationId", id),
            )
            .where(Predicate.eq("scope", scope)),
        );
        // Explicit edge deletion is required by the pinned server release.
        q = q.varAsIf(
          "dropEdge" + i,
          BatchCondition.varNotEmpty("guard"),
          g().dropEdgeById(EdgeRef.var("de" + i)),
        );
        q = q.varAsIf(
          "d" + i,
          BatchCondition.varNotEmpty("guard"),
          anchor(scope + ":" + id).drop(),
        );
        continue;
      }
      const props = {
        key: scope + ":" + id,
        scope,
        scopeKind: scope + ":" + c.put.kind,
        // Promoted for storage-level filtering and ordering (schema v2).
        // status mirrors data.status ("" when unset); updatedAt mirrors the
        // resource timestamp so newest-first pages sort in HelixDB.
        status: String(c.put.data.status ?? ""),
        updatedAt: c.put.updatedAt,
        doc: JSON.stringify(c.put),
      };
      const existing = !!present["p" + i]?.length;
      q = existing
        ? q.varAsIf(
            "u" + i,
            BatchCondition.varNotEmpty("guard"),
            anchor(scope + ":" + id)
              .setProperty("doc", props.doc)
              .setProperty("scopeKind", props.scopeKind)
              .setProperty("status", props.status)
              .setProperty("updatedAt", props.updatedAt),
          )
        : q.varAsIf(
            "new" + i,
            BatchCondition.varNotEmpty("guard"),
            g().addN("FoundryRecord", props),
          );
      if (!existing && c.put.kind === "relation") {
        q = q
          .varAsIf(
            "from" + i,
            BatchCondition.varNotEmpty("guard"),
            anchor(scope + ":" + c.put.data.from),
          )
          .varAsIf(
            "to" + i,
            BatchCondition.varNotEmpty("guard"),
            anchor(scope + ":" + c.put.data.to),
          )
          .varAsIf(
            "edge" + i,
            BatchCondition.varNotEmpty("guard"),
            g()
              .n(NodeRef.var("from" + i))
              .addE("FoundryRelationship", NodeRef.var("to" + i), {
                scope,
                generation: c.put.data.generation,
                name: c.put.name,
                relationId: c.put.id,
              }),
          );
      }
    }
    q = q.returning(["guard"]);
    try {
      const r = await this.write(q);
      return !!r.guard?.length;
    } catch (e) {
      // Retry transient server failures: optimistic-concurrency conflicts
      // and the pinned HelixDB v0.0.6's flaky cascades planner, which
      // intermittently rejects otherwise-valid write batches (nothing is
      // applied, so re-running the commit is safe).
      const err = e as { code?: string; message?: string };
      if (
        err.code === "internal_planner_error" ||
        /conflict|unique|planner error|cascades/i.test(String(err.message || e))
      )
        return false;
      throw e;
    }
  }
  async neighbors(scope: string, id: string) {
    const r = await this.read(
      readBatch()
        .varAs(
          "neighbors",
          anchor(scope + ":" + id)
            .both("FoundryRelationship")
            .where(Predicate.eq("scope", scope))
            .dedup()
            .limit(500)
            .valueMap(["doc"]),
        )
        .returning(["neighbors"]),
    );
    return (r.neighbors || []).map((n: any) => JSON.parse(n.doc).id);
  }
}
// Schema v2 backfill: rewrite every node so commit promotion materializes
// the top-level status/updatedAt properties on pre-upgrade data. Docs are
// byte-identical and revisions are untouched; only the indexed properties
// are added. Memory is bounded by one page of docs: kinds are discovered
// from a lightweight scopeKind property scan (no docs), then each kind is
// re-put in key-ordered pages of 100. Two passes absorb rows shifted by
// concurrent writes (the worker also runs init in parallel; its claim/run
// updates race ours). Idempotent, runs once (version). Skipped on the
// worker process — the app is the single backfill owner, and a process-
// level gate prevents the worker from doubling the work and the conflict
// window.
export const isAppProcess = (): boolean => {
  if (process.env.HELIX_FORCE_BACKFILL === "1") return true;
  const entry = process.argv[1] || "";
  // Match the API entrypoint specifically (dist/apps/api/src/server.js, or
  // apps/api/src/server.ts under tsx in dev). The executor runs its own
  // dist/services/executor/src/server.js, which must NOT be mistaken for the
  // app or it would own the backfill too.
  return /apps[\\/]api[\\/]src[\\/]server\.(?:ts|js)$/.test(entry);
};
async function backfillTopLevelProps(store: HelixStore) {
  if (!isAppProcess()) return;
  const scopes = [
    "global",
    ...(await store.list("global", "workspaceRef")).map((w) => w.id),
  ];
  for (const scope of scopes) {
    const r = await store.read(
      readBatch()
        .varAs(
          "recs",
          g()
            .nWithLabelWhere(
              "FoundryRecord",
              SourcePredicate.eq("scope", scope),
            )
            .valueMap(["scopeKind"]),
        )
        .returning(["recs"]),
    );
    const kinds = [
      ...new Set(
        ((r.recs || []) as Array<{ scopeKind?: string }>)
          .map((x) => String(x.scopeKind || ""))
          .filter((k) => k.startsWith(scope + ":"))
          .map((k) => k.slice(scope.length + 1)),
      ),
    ];
    for (let pass = 0; pass < 2; pass++)
      for (const kind of kinds) {
        let offset = 0;
        for (;;) {
          const { items, total } = await store.listPage(scope, kind, {
            order: { prop: "key", dir: "asc" },
            offset,
            limit: 100,
          });
          if (!items.length) break;
          await transaction(store, scope, async (tx) => {
            for (const x of items) tx.put(x);
          });
          offset += items.length;
          if (offset >= total) break;
        }
      }
  }
}
export class MemoryStore implements Store {
  private rows = new Map<string, Resource>();
  private versions = new Map<string, number>();
  async init() {}
  async list(s: string, k?: string) {
    return structuredClone(
      [...this.rows.values()].filter(
        (r) => r.workspaceId === s && (!k || r.kind === k),
      ),
    );
  }
  async get(s: string, id: string) {
    return structuredClone(this.rows.get(s + ":" + id));
  }
  async getMany(s: string, ids: string[]) {
    const out = new Map<string, Resource>();
    for (const id of new Set(ids)) {
      const r = this.rows.get(s + ":" + id);
      if (r) out.set(id, structuredClone(r));
    }
    return out;
  }
  async listPage(s: string, kind: string, opts: ListPageOpts = {}) {
    const statuses = opts.status
      ? Array.isArray(opts.status)
        ? opts.status
        : [opts.status]
      : [];
    let rows = [...this.rows.values()].filter(
      (r) =>
        r.workspaceId === s &&
        r.kind === kind &&
        (statuses.length === 0 ||
          statuses.includes(String(r.data.status ?? ""))),
    );
    const total = rows.length;
    if (opts.order) {
      const { prop, dir } = opts.order,
        mul = dir === "desc" ? -1 : 1;
      rows = rows.sort((a, b) => {
        const av = prop === "key" ? a.id : a.updatedAt,
          bv = prop === "key" ? b.id : b.updatedAt;
        return (
          mul * (av < bv ? -1 : av > bv ? 1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
      });
    }
    const offset = Math.max(opts.offset || 0, 0);
    rows =
      opts.limit === undefined
        ? rows.slice(offset)
        : rows.slice(offset, offset + Math.max(1, Math.min(opts.limit, 1000)));
    return { items: structuredClone(rows), total };
  }
  async version(s: string) {
    return this.versions.get(s) || 0;
  }
  async commit(s: string, v: number, cs: Change[]) {
    if ((this.versions.get(s) || 0) !== v) return false;
    this.versions.set(s, v + 1);
    for (const c of cs) {
      if ("put" in c) this.rows.set(s + ":" + c.put.id, structuredClone(c.put));
      else this.rows.delete(s + ":" + c.delete);
    }
    return true;
  }
  async neighbors(s: string, id: string) {
    return [
      ...new Set(
        (await this.list(s, "relation"))
          .filter((r) => r.data.from === id || r.data.to === id)
          .map((r) => (r.data.from === id ? r.data.to : r.data.from)),
      ),
    ];
  }
}
export class Tx {
  changes: Change[] = [];
  constructor(
    public store: Store,
    public scope: string,
  ) {}
  async get(id: string) {
    const pending = this.changes.findLast(
      (c) => ("put" in c ? c.put.id : c.delete) === id,
    );
    return pending
      ? "put" in pending
        ? pending.put
        : undefined
      : this.store.get(this.scope, id);
  }
  async list(kind?: string) {
    const rows = new Map(
      (await this.store.list(this.scope, kind)).map((r) => [r.id, r]),
    );
    for (const c of this.changes) {
      if ("delete" in c) rows.delete(c.delete);
      else if (!kind || c.put.kind === kind) rows.set(c.put.id, c.put);
      else rows.delete(c.put.id);
    }
    return [...rows.values()];
  }
  put(r: Resource) {
    if (r.workspaceId !== this.scope) throw new Error("Scope mismatch");
    this.changes.push({ put: r });
    return r;
  }
  delete(id: string) {
    this.changes.push({ delete: id });
  }
  update(r: Resource, data: Record<string, any>) {
    return this.put({ ...r, data, revision: r.revision + 1, updatedAt: now() });
  }
}
export async function transaction<T>(
  store: Store,
  scope: string,
  fn: (tx: Tx) => Promise<T>,
) {
  for (let i = 0; i < 5; i++) {
    const v = await store.version(scope),
      tx = new Tx(store, scope),
      result = await fn(tx);
    if (!tx.changes.length || (await store.commit(scope, v, tx.changes)))
      return result;
    await new Promise((r) => setTimeout(r, 20 * (i + 1)));
  }
  throw new AppError(409, "Concurrent change. Please retry.");
}
export const store = new HelixStore();
