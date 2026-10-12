import {
  type Catalog,
  CatalogSchema,
  type ColumnProfile,
  datasetTable,
  type Resource,
  type SuggestedEntity,
  type SuggestedLink,
  type SuggestedOntology,
} from "../../../../packages/shared/src/index.js";
import { queryDatasets } from "../datasets.js";
import {
  derivedBusinessName,
  indexCatalog,
  normTable,
  resolveColumn,
} from "../catalog-match.js";
import { digest } from "../security.js";
import type { Store } from "../store.js";
import { entityColumns } from "./columns.js";
import {
  type Col,
  declaredKeys,
  type Draft,
  type Edge,
  email,
  idName,
  type Info,
  keyName,
  keyType,
  nested,
  noun,
  ownKey,
  provisionalKey,
  sameStem,
  schemaSig,
  stem,
  structFields,
} from "./keys.js";
import {
  cmp,
  count,
  datasetLabel,
  entityName,
  human,
  list,
  lit,
  lowerFirst,
  plural,
  q,
  singular,
  slug,
  sourceLabel,
  tableName,
  words,
} from "./names.js";

export type SuggestStage = "reading" | "keys" | "matching" | "proposing";
export async function suggestOntology(
  store: Store,
  scope: string,
  input: {
    datasets: Resource[];
    sources: Resource[];
    signature: string;
    onProgress?: (stage: SuggestStage) => void;
  },
): Promise<SuggestedOntology> {
  const progress = input.onProgress || (() => {});
  const sources = new Map(input.sources.map((s) => [s.id, s]));
  const infos: Info[] = input.datasets
    .filter((d) => d.data.activeVersion && d.data.profile?.columns)
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id))
    .map((d, index) => {
      const s = d.data.sourceId && sources.get(d.data.sourceId);
      const [source, system] = d.data.sampleSource
        ? [d.data.sampleSource, "sample:" + d.data.sampleSource]
        : s
          ? [s.data.kind, "connection:" + (s.data.connectionId || s.id)]
          : ["upload", "dataset:" + d.id];
      return {
        d,
        index,
        table: tableName(d.name, source),
        source,
        system,
        columns: d.data.profile.columns,
        rows: d.data.profile.rows,
        alt: new Set<string>(),
      };
    });
  // An imported data catalog (any upstream) overrides guessing: asserted keys
  // place keyless tables, business names replace slugs, and curated joins
  // become links. Absent a catalog, discovery falls back to statistical/AI.
  let catalog: Catalog | undefined;
  try {
    const stored = await store.get(scope, "catalog");
    if (stored) catalog = CatalogSchema.parse(stored.data);
  } catch {
    catalog = undefined;
  }
  const catalogTables = catalog ? indexCatalog(catalog) : new Map();
  const catalogFor = (datasetName: string) =>
    catalogTables.get(normTable(datasetName));
  for (const x of infos) {
    x.key = ownKey(x);
    const entry = catalogFor(x.d.name) || catalogFor(x.table);
    if (!x.key && entry?.keys?.length)
      // Asserted (possibly composite) key, trusted on import.
      x.key = entry.keys[0].join(" + ");
    for (const c of x.columns)
      if (
        c.name !== x.key &&
        c.primaryKey &&
        keyType(c.type) &&
        keyName(c.name) &&
        !idName(c.name)
      )
        x.alt.add(c.name);
  }
  progress("reading");
  const declared = declaredKeys(infos, sources);
  progress("keys");
  const cols: Col[] = [];
  const column = (x: Info, c: ColumnProfile, field?: string) => {
    const name = field ? c.name + "." + field : c.name;
    const found = cols.find((y) => y.ds === x && y.name === name);
    if (found) return found;
    const col: Col = {
      i: cols.length,
      ds: x,
      name,
      column: c.name,
      field,
      integer: !field && /INT/.test(c.type),
      unique:
        !x.d.data.profile.approximate &&
        !field &&
        c.distinct > 0 &&
        c.distinct === x.rows - c.nulls,
      key: !field && c.primaryKey,
    };
    cols.push(col);
    return col;
  };
  // A column named for another table (orders.customer, Stripe's invoice.subscription)
  // references it just like a *_id column.
  const refersTo = (x: Info, name: string) =>
    infos.some((y) => y !== x && noun(y.table) === noun(name));
  for (const x of infos)
    for (const c of x.columns) {
      if (
        keyType(c.type) &&
        (keyName(c.name) || refersTo(x, c.name)) &&
        c.distinct >= 2
      )
        column(x, c);
      for (const f of structFields(c.type)) if (keyName(f)) column(x, c, f);
    }
  const declaredPairs = new Set<string>();
  for (const [from, fromColumn, to, toColumn] of declared) {
    const a = from.columns.find((c) => c.name === fromColumn),
      b = to.columns.find((c) => c.name === toColumn);
    if (a && b && keyType(a.type) && keyType(b.type))
      declaredPairs.add(column(from, a).i + ":" + column(to, b).i);
  }
  // Value matching is best-effort at scale: if the overlap query times out
  // (hundreds of tables), the suggestion still completes with schema/name
  // links rather than failing the whole request.
  progress("matching");
  let rows: Awaited<ReturnType<typeof overlap>> = [];
  // Curated joins replace statistical matching (which finds nothing at this
  // scale but costs minutes); the overlap only runs without a catalog.
  const curatedLinks = catalog?.joins.length || 0;
  if (cols.length > 1 && !curatedLinks) {
    try {
      rows = await overlap(store, scope, cols, declaredPairs);
    } catch (error) {
      console.warn(`[discovery] value overlap skipped (${cols.length} columns):`, error instanceof Error ? error.message : error);
    }
  }

  let edges: Edge[] = [];
  for (const r of rows) {
    const A = cols[r.a],
      B = cols[r.b];
    if (!A || !B || B.field) continue;
    const isDeclared = declaredPairs.has(A.i + ":" + B.i),
      bOwn = B.ds.key === B.name,
      bAlt = B.ds.alt.has(B.name),
      aOwn = !A.field && A.ds.key === A.name,
      aKey = aOwn || (!A.field && A.ds.alt.has(A.name));
    // Targets are a table's own key (or an alternate email/code key), which drops
    // transitive overlap such as invoices.customer_id -> subscriptions.customer_id.
    if (
      isDeclared
        ? !B.key
        : !(bOwn || bAlt) ||
          (bAlt && aOwn) ||
          ((A.integer || B.integer) && !sameStem(stem(A), stem(B)))
    )
      continue;
    const ci = email(A.name) || r.a_rows_exact < r.a_rows_ci;
    const m = ci ? r.m_ci : r.m_exact,
      distinct = ci ? r.a_distinct_ci : r.a_distinct,
      matched = ci ? r.a_rows_ci : r.a_rows_exact;
    if (
      !(isDeclared ? m > 0 : m / distinct >= 0.8 || matched / r.a_rows >= 0.9)
    )
      continue;
    const aw = words(A.name),
      bw = words(B.name);
    // Two uploads are one system to the user: a conventional foreign key between
    // them (subscriptions.customer_id) is a link, while a key named for another
    // system (stripe_customer_id, external_id) can still mean the same record.
    const conventional =
      aw.join("_") === bw.join("_") ||
      (aw.length > 1 &&
        idName(A.name) &&
        aw.slice(0, -1).map(singular).join("_") === noun(B.ds.table));
    // Merging needs exact matches, so the combined record joins without lower().
    const exact =
      r.m_exact / r.a_distinct >= 0.8 || r.a_rows_exact / r.a_rows >= 0.9;
    const identity =
      !A.field &&
      A.unique &&
      B.key &&
      A.ds.system !== B.ds.system &&
      !(A.ds.source === "upload" && B.ds.source === "upload" && conventional) &&
      exact;
    // A table keyed by another table's key (user_profiles.user_id) extends it 1:1.
    const extension =
      aOwn &&
      bOwn &&
      !identity &&
      A.ds.system === B.ds.system &&
      (isDeclared || m / distinct >= 0.8) &&
      noun(A.ds.table) !== stem(A) &&
      noun(B.ds.table) === stem(A);
    if (aKey && !identity && !extension) continue;
    const nameMatch =
      aw.join("_") === bw.join("_") ||
      aw.map(singular).includes(stem(B)) ||
      (bw.length === 1 && aw.at(-1) === bw[0]);
    edges.push({
      A,
      B,
      identity,
      extension,
      declared: isDeclared,
      evidence: isDeclared ? "declared" : nameMatch ? "name" : "values",
      exact: r.m_exact,
      matched,
      total: r.a_rows,
      caseRows: ci ? r.a_rows_ci - r.a_rows_exact : 0,
    });
  }
  // Serial integer ids overlap by chance, so two tables keyed by `id` are only the
  // same records when a declared key or a non-integer match between them agrees.
  const serial = (e: Edge) =>
    e.identity &&
    !e.declared &&
    e.A.integer &&
    e.B.integer &&
    e.A.ds.key === e.A.name &&
    e.B.ds.key === e.B.name;
  edges = edges.filter(
    (e) =>
      !serial(e) ||
      edges.some(
        (o) =>
          (o.identity || o.A.field) &&
          !o.A.integer &&
          ((o.A.ds === e.A.ds && o.B.ds === e.B.ds) ||
            (o.A.ds === e.B.ds && o.B.ds === e.A.ds)),
      ),
  );
  const rank = { declared: 2, name: 1, values: 0 };
  const strength = (a: Edge, b: Edge) =>
    b.exact - a.exact ||
    rank[b.evidence] - rank[a.evidence] ||
    b.matched / b.total - a.matched / a.total ||
    cmp(
      a.A.ds.d.name + a.A.name + a.B.ds.d.name + a.B.name,
      b.A.ds.d.name + b.A.name + b.B.ds.d.name + b.B.name,
    );
  edges.sort(strength);

  // Union-find over 1:1 cross-system links; an entity holds at most one dataset per
  // system, which stops an email match from merging accounts with users.
  const parent = infos.map((_, i) => i),
    systems = infos.map((x) => new Set([x.system]));
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  const tree: Edge[] = [],
    corroborating: Edge[] = [];
  for (const e of edges.filter((e) => e.identity)) {
    const a = find(e.A.ds.index),
      b = find(e.B.ds.index);
    if (a === b) corroborating.push(e);
    else if ([...systems[b]].some((s) => systems[a].has(s))) e.identity = false;
    else {
      parent[b] = a;
      systems[a] = new Set([...systems[a], ...systems[b]]);
      tree.push(e);
    }
  }
  const candidates = edges.filter(
    (e) =>
      !e.identity &&
      !e.A.field &&
      (e.extension || !(e.A.ds.key === e.A.name || e.A.ds.alt.has(e.A.name))),
  );
  // A key matching several tables refers to the one named for it: user_id points
  // at users, not at user_profiles, which is keyed by user_id too.
  const named = (e: Edge) => noun(e.B.ds.table) === stem(e.A);
  const references = candidates.filter(
    (e) =>
      e.declared ||
      named(e) ||
      !candidates.some((o) => o.A === e.A && o.B.ds !== e.B.ds && named(o)),
  );
  const degree = new Map<Info, number>();
  for (const e of [...tree, ...corroborating, ...references])
    for (const x of [e.A.ds, e.B.ds]) degree.set(x, (degree.get(x) || 0) + 1);
  const groups = new Map<number, Info[]>();
  for (const x of infos)
    groups.set(find(x.index), [...(groups.get(find(x.index)) || []), x]);

  const drafts: Draft[] = [],
    unplaced: string[] = [],
    entityOf = new Map<Info, Draft>();
  const appDb = (x: Info) =>
    ["planetscale", "postgres", "mysql"].includes(x.source) ? 1 : 0;
  for (const group of groups.values()) {
    let anchor = group
      .filter((x) => x.key || x.alt.size)
      .sort(
        (a, b) =>
          appDb(b) - appDb(a) ||
          (degree.get(b) || 0) - (degree.get(a) || 0) ||
          b.rows - a.rows ||
          cmp(a.d.name, b.d.name),
      )[0];
    let provisional: string | undefined;
    if (!anchor) {
      // No proven unique key: fall back to a name-inferred near-key so the group
      // is placed, not dropped. It labels the entity; it never drives links.
      const prot = group
        .map((x) => ({ x, key: provisionalKey(x) }))
        .filter((p) => p.key)
        .sort((a, b) => b.x.rows - a.x.rows || cmp(a.x.d.name, b.x.d.name))[0];
      if (!prot) {
        unplaced.push(...group.map((x) => x.d.id));
        continue;
      }
      anchor = prot.x;
      provisional = prot.key;
    }
    const anchorKey = anchor.key || [...anchor.alt][0] || provisional;
    if (!anchorKey) {
      unplaced.push(...group.map((x) => x.d.id));
      continue;
    }
    const member = (
      x: Info,
      via: SuggestedEntity["members"][number]["via"],
    ) => ({
      datasetId: x.d.id,
      datasetName: x.d.name,
      source: x.source,
      key: x.key || via?.column || [...x.alt][0] || (x === anchor ? anchorKey : ""),
      rows: x.rows,
      matched: x.rows,
      via,
    });
    const draft: Draft = {
      members: [member(anchor, null)],
      anchor,
      key: anchorKey,
      kind: "record",
      degree: 0,
      name: "",
      id: "",
    };
    const joined = new Set([anchor]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of tree) {
        const [inner, outer] = joined.has(e.A.ds)
          ? [e.A, e.B]
          : joined.has(e.B.ds)
            ? [e.B, e.A]
            : [];
        if (!inner || !outer || joined.has(outer.ds)) continue;
        joined.add(outer.ds);
        draft.members.push({
          ...member(outer.ds, {
            column: outer.name,
            targetDatasetId: inner.ds.d.id,
            targetColumn: inner.name,
          }),
          matched: e.exact,
        });
        grew = true;
      }
    }
    for (const x of group) entityOf.set(x, draft);
    drafts.push(draft);
  }

  // Same-system drafts whose anchors share a normalized schema are one logical
  // table (repeated exports, snapshots) even when their rows are disjoint and no
  // value overlap exists. Metadata-only: no executor calls. Same-system only, so a
  // Parquet email never merges with a Stripe email on name alone.
  {
    const sigs = new Map(drafts.map((d) => [d, schemaSig(d.anchor)] as const));
    const uses = new Map<string, number>();
    for (const s of sigs.values())
      for (const n of s) uses.set(n, (uses.get(n) || 0) + 1);
    // Corpus-relative rarity: a shared name is distinctive when few datasets use
    // it, so a shared id alone never merges while a shared sku can.
    const distinctive = (n: string) =>
      (uses.get(n) || 0) <= Math.max(3, infos.length / 4);
    const mergeable = (a: Draft, b: Draft) => {
      if (a === b || a.anchor.system !== b.anchor.system) return false;
      const sa = sigs.get(a)!,
        sb = sigs.get(b)!;
      let shared = 0;
      for (const n of sa) if (sb.has(n)) shared++;
      if (shared < 2) return false;
      if (![...sa].some((n) => sb.has(n) && distinctive(n))) return false;
      const union = sa.size + sb.size - shared,
        score = union ? shared / union : 0;
      return (
        score === 1 ||
        (score >= 0.8 && Math.min(sa.size, sb.size) >= 4 && shared >= 3)
      );
    };
    const parent = new Map(drafts.map((d) => [d, d] as const));
    const find = (d: Draft): Draft => {
      const p = parent.get(d)!;
      if (p === d) return d;
      const r = find(p);
      parent.set(d, r);
      return r;
    };
    for (let i = 0; i < drafts.length; i++)
      for (let j = i + 1; j < drafts.length; j++)
        if (mergeable(drafts[i], drafts[j])) {
          const a = find(drafts[i]),
            b = find(drafts[j]);
          if (a !== b) parent.set(b, a);
        }
    const sets = new Map<Draft, Draft[]>();
    for (const d of drafts) {
      const r = find(d);
      sets.set(r, [...(sets.get(r) || []), d]);
    }
    for (const group of sets.values()) {
      if (group.length < 2) continue;
      const survivor = [...group].sort(
        (a, b) =>
          b.anchor.rows - a.anchor.rows || cmp(a.anchor.d.name, b.anchor.d.name),
      )[0];
      for (const d of group) {
        if (d === survivor) continue;
        for (const m of d.members) {
          const x = infos.find((i) => i.d.id === m.datasetId)!;
          survivor.members.push({
            datasetId: m.datasetId,
            datasetName: m.datasetName,
            source: m.source,
            key: survivor.key,
            rows: m.rows,
            matched: m.rows,
            via: null,
          });
          entityOf.set(x, survivor);
        }
        drafts.splice(drafts.indexOf(d), 1);
      }
    }
  }

  // One link per entity pair and column; prefer the target entity's anchor dataset.
  const best = new Map<string, { e: Edge; from: Draft; to: Draft }>();
  for (const e of references) {
    const from = entityOf.get(e.A.ds),
      to = entityOf.get(e.B.ds);
    if (!from || !to || from === to) continue;
    const k = [drafts.indexOf(from), drafts.indexOf(to), e.A.name].join(":");
    const cur = best.get(k);
    const score = (x: Edge) => [
      x.B.ds === to.anchor ? 1 : 0,
      rank[x.evidence],
      x.matched,
    ];
    const [x, y] = [score(e), cur ? score(cur.e) : []],
      i = x.findIndex((v, j) => v !== y[j]);
    if (!cur || (i >= 0 && x[i] > y[i])) best.set(k, { e, from, to });
  }
  const refs = await withoutImplied(store, scope, [...best.values()]);
  const hasTime = (x: Info) =>
    x.columns.some((c) => /^(TIMESTAMP|DATE)/.test(c.type));
  // Large event streams feed metrics but are not stored as records. A large orders
  // table is still a record, so the stream must also look like one.
  const eventLike = (x: Info) =>
    x.source === "posthog" ||
    x.rows > 50000 ||
    words(x.table)
      .map(singular)
      .some((w) =>
        "event activity log track tracking click pageview visit session audit"
          .split(" ")
          .includes(w),
      );
  const streams = new Set(
    drafts.filter(
      (d) =>
        d.members.length === 1 &&
        d.anchor.rows > 2000 &&
        hasTime(d.anchor) &&
        eventLike(d.anchor) &&
        refs.some((r) => r.from === d) &&
        !refs.some((r) => r.to === d),
    ),
  );
  for (const d of streams)
    if (refs.some((r) => r.from === d && !streams.has(r.to)))
      d.kind = "activity";
  for (const r of refs) {
    r.from.degree++;
    r.to.degree++;
  }
  drafts.sort(
    (a, b) =>
      (a.kind === "activity" ? 1 : 0) - (b.kind === "activity" ? 1 : 0) ||
      b.degree - a.degree ||
      b.anchor.rows - a.anchor.rows ||
      cmp(a.anchor.d.name, b.anchor.d.name),
  );
  const names = new Set<string>(),
    ids = new Set<string>();
  for (const d of drafts) {
    // An imported catalog names entities; the existing dedupe still applies.
    // Provenance is recorded so bulk renaming can target slugs later.
    const catalogued = [d.anchor, ...d.members.map((m) => infos.find((x) => x.d.id === m.datasetId)!)].find(
      (x) =>
        x &&
        derivedBusinessName(
          catalogFor(x.d.name) || catalogFor(x.table) || { table: "" },
        ),
    );
    const entry = catalogued
      ? catalogFor(catalogued.d.name) || catalogFor(catalogued.table)
      : undefined;
    const explicit = entry?.businessName?.trim() || "";
    const business = catalogued ? derivedBusinessName(entry!) : "";
    d.namedBy = explicit ? "catalog" : business ? "derived" : "slug";
    let name = business || entityName(d.anchor.table);
    if (names.has(name.toLowerCase()))
      name =
        `${name} (${d.anchor.source === "upload" ? "upload" : sourceLabel(d.anchor.source)})`.slice(
          0,
          60,
        );
    for (let n = 2; names.has(name.toLowerCase()); n++)
      name = `${entityName(d.anchor.table)} ${n}`;
    names.add(name.toLowerCase());
    let id = slug(name);
    for (let n = 2; ids.has(id); n++) id = slug(name) + "_" + n;
    ids.add(id);
    d.name = name;
    d.id = id;
  }
  progress("proposing");
  const byDataset = new Map(infos.map((x) => [x.d.id, x.d]));
  const plain = (d: Draft) => lowerFirst(d.name);
  const entities: SuggestedEntity[] = drafts.map((d) => {
    const targets = refs.filter((r) => r.from === d).map((r) => r.to);
    const others = d.members.slice(1).map((m) => {
      const x = infos.find((i) => i.d.id === m.datasetId)!;
      return datasetLabel(x);
    });
    const description =
      `${count(d.anchor.rows, plain(d))} from ${d.anchor.source === "upload" ? "an upload" : sourceLabel(d.anchor.source)}` +
      (others.length
        ? `, joined with ${list(others)}.`
        : d.kind === "activity"
          ? `, linked to ${list([...new Set(targets.map((t) => plural(plain(t))))])}.`
          : ".");
    const entity: SuggestedEntity = {
      id: d.id,
      name: d.name,
      namedBy: d.namedBy || "slug",
      description,
      kind: d.kind,
      anchorDatasetId: d.anchor.d.id,
      key: d.key,
      rows: d.anchor.rows,
      members: d.members,
      properties: [],
    };
    entity.properties = entityColumns(entity, byDataset)
      .filter((c) => !nested(c.type))
      .map((c) => c.as);
    return entity;
  });
  const order = new Map(drafts.map((d, i) => [d, i]));
  refs.sort(
    (a, b) =>
      order.get(a.from)! - order.get(b.from)! ||
      order.get(a.to)! - order.get(b.to)! ||
      cmp(a.e.A.name, b.e.A.name),
  );
  const linkIds = new Set<string>();
  const links: SuggestedLink[] = refs.map(({ e, from, to }) => {
    let id = `${from.id}-${slug(e.A.name)}-${to.id}`;
    for (let n = 2; linkIds.has(id); n++)
      id = `${from.id}-${slug(e.A.name)}-${to.id}-${n}`;
    linkIds.add(id);
    return {
      id,
      name: e.extension ? "extends" : linkName(e.A.name),
      from: from.id,
      to: to.id,
      fromDatasetId: e.A.ds.d.id,
      fromColumn: e.A.name,
      toDatasetId: e.B.ds.d.id,
      toColumn: e.B.name,
      totalRows: e.total,
      matchedRows: e.matched,
      caseInsensitive: e.caseRows > 0,
      evidence: e.evidence,
    };
  });

  // Curated joins from an imported catalog become links (evidence declared).
  // Counts are asserted by the curator (coverage floors live in the catalog),
  // not measured by Helix; a later validation pass can measure them.
  if (catalog?.joins.length) {
    // Extract variants share normalized names; each join picks the variant
    // actually carrying its key (never first-wins).
    const variants = new Map<string, (typeof infos)[number][]>();
    for (const x of infos)
      for (const n of [normTable(x.d.name), normTable(x.table)]) {
        const list = variants.get(n);
        if (list) {
          if (!list.includes(x)) list.push(x);
        } else variants.set(n, [x]);
      }
    const pick = (table: string, key: string) =>
      (variants.get(normTable(table)) || []).find((x) =>
        resolveColumn(x.columns, key),
      );
    const entityByDataset = new Map<string, string>();
    for (const e of entities)
      for (const m of e.members)
        if (!entityByDataset.has(m.datasetId))
          entityByDataset.set(m.datasetId, e.id);
    const covered = new Set(
      links.map((l) =>
        [
          `${l.fromDatasetId}|${l.fromColumn}|${l.toDatasetId}|${l.toColumn}`,
          `${l.toDatasetId}|${l.toColumn}|${l.fromDatasetId}|${l.fromColumn}`,
        ].join("~"),
      ),
    );
    for (const j of catalog.joins) {
      const a = pick(j.leftTable, j.leftKey),
        b = pick(j.rightTable, j.rightKey);
      if (!a || !b) continue;
      const aCol = resolveColumn(a.columns, j.leftKey)!,
        bCol = resolveColumn(b.columns, j.rightKey)!;
      const from = entityByDataset.get(a.d.id),
        to = entityByDataset.get(b.d.id);
      if (!from || !to || from === to) continue;
      if (
        covered.has(
          `${a.d.id}|${aCol}|${b.d.id}|${bCol}~${b.d.id}|${bCol}|${a.d.id}|${aCol}`,
        )
      )
        continue;
      let id =
        `catalog-${normTable(j.leftTable)}-${j.leftKey}-${normTable(j.rightTable)}-${j.rightKey}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-");
      for (let n = 2; linkIds.has(id); n++) id = `${id}-${n}`;
      linkIds.add(id);
      links.push({
        id,
        name: "references",
        from,
        to,
        fromDatasetId: a.d.id,
        fromColumn: aCol,
        toDatasetId: b.d.id,
        toColumn: bCol,
        totalRows: a.rows,
        matchedRows: a.rows,
        caseInsensitive: false,
        evidence: "declared",
      });
    }
  }

  // Anchor reachability refinement only pays for statistical member links;
  // curated links are already anchor-correct (and asserted counts stand).
  // Skipping also avoids pathological multi-hop scans over giant tables.
  if (refs.length) await throughAnchor(store, scope, links, entities);

  // Curated links arrive after statistical degree was tallied: recount from
  // the final link set so the unlinked-data notes below only flag entities
  // with no links at all.
  for (const d of drafts)
    d.degree = links.filter((l) => l.from === d.id || l.to === d.id).length;

  const notes: SuggestedOntology["notes"] = [];
  const info = (id: string) => infos.find((x) => x.d.id === id)!;
  // Other 1:1 matches inside an entity, struct fields included, confirm the merge;
  // the join's own column pair, read in reverse, is not a second match.
  const confirmedBy = (d: Draft, datasetId: string) => {
    const via = d.members.find((m) => m.datasetId === datasetId)?.via;
    const join = new Set(
      via
        ? [
            [datasetId, via.column, via.targetDatasetId, via.targetColumn],
            [via.targetDatasetId, via.targetColumn, datasetId, via.column],
          ].map((p) => p.join("\u0000"))
        : [],
    );
    return [
      ...new Set(
        [...corroborating, ...edges.filter((e) => e.A.field)]
          .filter(
            (e) =>
              entityOf.get(e.A.ds) === d &&
              entityOf.get(e.B.ds) === d &&
              (e.A.ds.d.id === datasetId || e.B.ds.d.id === datasetId) &&
              !join.has(
                [e.A.ds.d.id, e.A.name, e.B.ds.d.id, e.B.name].join("\u0000"),
              ),
          )
          .map((e) => (e.A.ds.d.id === datasetId ? e.A.name : e.B.name)),
      ),
    ];
  };
  for (const d of drafts.filter((d) => d.members.length > 1))
    notes.push({
      kind: "merged",
      entities: [d.id],
      text: `${d.name} combines ${datasetLabel(d.anchor)} with ${list(
        d.members.slice(1).map((m) => {
          const also = confirmedBy(d, m.datasetId);
          return `${datasetLabel(info(m.datasetId))} (${m.matched.toLocaleString("en-US")} of ${m.rows.toLocaleString("en-US")} match${also.length ? ", confirmed by " + list(also) : ""})`;
        }),
      )}.`,
    });
  for (const d of drafts)
    for (const m of d.members.slice(1))
      if (m.rows > m.matched) {
        const n = m.rows - m.matched;
        notes.push({
          kind: "unmatched",
          entities: [d.id],
          text: `${n.toLocaleString("en-US")} ${datasetLabel(info(m.datasetId), n)} ${n === 1 ? "doesn't" : "don't"} match any ${plain(d)}.`,
        });
      }
  for (const [i, { e, to }] of refs.entries()) {
    const n = e.total - links[i].matchedRows,
      about = { entities: [links[i].from, links[i].to], links: [links[i].id] };
    if (n > 0)
      notes.push({
        kind: "unmatched",
        ...about,
        text: `${n.toLocaleString("en-US")} ${datasetLabel(e.A.ds, n)} ${n === 1 ? "has" : "have"} a ${e.A.name} that doesn't match any ${plain(to)}.`,
      });
    if (links[i].caseInsensitive) {
      const what = email(e.A.name)
        ? human(words(e.A.name.replace(/_?e-?mail$/i, "")).concat(["email"]))
        : `${plain(to)} code`;
      notes.push({
        kind: "case",
        ...about,
        text: `${count(e.caseRows, what)} only ${e.caseRows === 1 ? "matches" : "match"} when ignoring case.`,
      });
    }
  }
  if (drafts.length > 1)
    for (const d of drafts)
      if (!d.degree)
        notes.push({
          kind: "unlinked",
          entities: [d.id],
          text: `${d.name} isn't linked to the other data.`,
        });
  for (const id of unplaced)
    notes.push({
      kind: "unlinked",
      text: `${byDataset.get(id)!.name} has no unique column to identify its rows, so it isn't shown as an entity.`,
    });

  // Uploads count as one source, however many files there are.
  const summary = summarize(
    entities,
    infos.length,
    new Set(infos.map((x) => (x.source === "upload" ? "upload" : x.system)))
      .size,
  );
  const hash = digest(
    JSON.stringify({
      entities: entities.map((e) => [
        e.id,
        e.kind,
        e.anchorDatasetId,
        e.key,
        e.members.map((m) => [m.datasetId, m.key, m.via]),
      ]),
      links: links.map((l) => [
        l.id,
        l.from,
        l.to,
        l.fromDatasetId,
        l.fromColumn,
        l.toDatasetId,
        l.toColumn,
        l.caseInsensitive,
      ]),
    }),
  );
  return {
    signature: input.signature,
    hash,
    summary,
    described: false,
    entities,
    links,
    notes,
    unplaced,
  };
}

// "7 entities and 1 activity stream from 11 datasets across 5 sources. Accounts
// combine PlanetScale, WorkOS and Stripe."
export function summarize(
  entities: SuggestedEntity[],
  datasets: number,
  sources: number,
) {
  const records = entities.filter((e) => e.kind === "record").length,
    streams = entities.length - records;
  const merged = entities
    .filter((e) => e.members.length > 1)
    .map(
      (e) =>
        `${plural(lowerFirst(e.name))} combine ${list([
          ...new Set(
            e.members.map((m) =>
              m.source === "upload"
                ? human(words(tableName(m.datasetName, m.source)))
                : sourceLabel(m.source),
            ),
          ),
        ])}`,
    );
  return (
    `${count(records, "entity")}${streams ? ` and ${count(streams, "activity stream")}` : ""} from ${count(datasets, "dataset")} across ${count(sources, "source")}.` +
    (merged.length
      ? " " + merged.join("; ").replace(/^./, (c) => c.toUpperCase()) + "."
      : "")
  );
}

// A link into a merged entity's other dataset (subscriptions -> Stripe customers,
// part of Account) only resolves for the rows that joined the anchor, so it is
// counted the way the built relationship will be. One executor call.
async function throughAnchor(
  store: Store,
  scope: string,
  links: SuggestedLink[],
  entities: SuggestedEntity[],
) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const text = (alias: string, column: string, ci = false) =>
    ci
      ? `lower(trim(CAST(${alias}.${q(column)} AS VARCHAR)))`
      : `CAST(${alias}.${q(column)} AS VARCHAR)`;
  const ids = new Set<string>();
  // Values of a member column for the member rows that reach the anchor.
  const joined = (
    e: SuggestedEntity,
    datasetId: string,
    column: string,
    depth: number,
  ): string | undefined => {
    const m = e.members.find((x) => x.datasetId === datasetId);
    if (!m || depth > e.members.length) return undefined;
    ids.add(datasetId);
    const alias = "j" + depth,
      from = `SELECT ${text(alias, column)} AS v FROM ${q(datasetTable(datasetId))} ${alias}`;
    if (!m.via) return from;
    const target = joined(
      e,
      m.via.targetDatasetId,
      m.via.targetColumn,
      depth + 1,
    );
    return (
      target && `${from} WHERE ${text(alias, m.via.column)} IN (${target})`
    );
  };
  const counts = links.flatMap((l, i) => {
    const to = byId.get(l.to);
    if (!to || l.toDatasetId === to.anchorDatasetId) return [];
    const values = joined(to, l.toDatasetId, l.toColumn, 0);
    if (!values) return [];
    ids.add(l.fromDatasetId);
    const ci = l.caseInsensitive;
    return [
      `SELECT ${i} AS k, count(*) AS n FROM ${q(datasetTable(l.fromDatasetId))} a WHERE ${text("a", l.fromColumn, ci)} IN (SELECT ${ci ? "lower(trim(v))" : "v"} FROM (${values}) AS t)`,
    ];
  });
  if (!counts.length) return;
  const r = await queryDatasets(
    store,
    scope,
    [...ids],
    counts.join(" UNION ALL "),
    {
      limit: 1000,
    },
  );
  for (const row of r.rows) {
    const l = links[Number(row.k)];
    l.matchedRows = Math.min(l.matchedRows, Number(row.n));
  }
}

type Ref = { e: Edge; from: Draft; to: Draft };
// A direct link A -> C that a two-hop path A -> B -> C already gives (invoice ->
// subscription -> account) is left to traversal, once the data shows both routes
// reach the same record. Checked in one executor call.
async function withoutImplied(store: Store, scope: string, refs: Ref[]) {
  const paths = refs.flatMap((direct) =>
    refs.flatMap((first) =>
      first === direct || first.from !== direct.from || first.to === direct.to
        ? []
        : refs
            .filter(
              (second) =>
                second !== direct &&
                second.from === first.to &&
                second.to === direct.to &&
                // Comparable row by row: both routes start on the same table, the
                // first hop lands where the second starts, and both end on one column.
                first.e.A.ds === direct.e.A.ds &&
                first.e.B.ds === second.e.A.ds &&
                second.e.B.ds === direct.e.B.ds &&
                second.e.B.name === direct.e.B.name,
            )
            .map((second) => ({ direct, first, second })),
    ),
  );
  if (!paths.length) return refs;
  const value = (expr: string, ci: boolean) =>
    ci ? `lower(trim(CAST(${expr} AS VARCHAR)))` : `CAST(${expr} AS VARCHAR)`;
  const sql = paths
    .map(({ direct, first, second }, i) => {
      const hop = first.e.caseRows > 0,
        end = direct.e.caseRows > 0 || second.e.caseRows > 0,
        d = `a.${q(direct.e.A.name)}`,
        via = `b.${q(second.e.A.name)}`;
      // Every row with the direct key counts: one whose path is missing (no first hop,
      // or no second key) would lose its only route to the target.
      return `SELECT ${i} AS k, count(*) AS n, count(*) FILTER (WHERE ${via} IS NOT NULL AND ${value(d, end)} = ${value(via, end)}) AS agree
FROM ${q(datasetTable(direct.e.A.ds.d.id))} a LEFT JOIN ${q(datasetTable(first.e.B.ds.d.id))} b
ON ${value(`a.${q(first.e.A.name)}`, hop)} = ${value(`b.${q(first.e.B.name)}`, hop)}
WHERE ${d} IS NOT NULL`;
    })
    .join(" UNION ALL ");
  const ids = [
    ...new Set(
      paths.flatMap((p) => [p.direct.e.A.ds.d.id, p.first.e.B.ds.d.id]),
    ),
  ];
  const r = await queryDatasets(store, scope, ids, sql, { limit: 1000 });
  const agreed = new Set(
    r.rows
      .filter(
        (row) => Number(row.n) > 0 && Number(row.agree) >= 0.95 * Number(row.n),
      )
      .map((row) => Number(row.k)),
  );
  // Paths must stay intact: never drop a hop of a dropped link, or drop a link
  // through a hop that was dropped.
  const implied = new Set<Ref>(),
    hops = new Set<Ref>();
  for (const [i, p] of paths.entries())
    if (
      agreed.has(i) &&
      !hops.has(p.direct) &&
      !implied.has(p.first) &&
      !implied.has(p.second)
    ) {
      implied.add(p.direct);
      hops.add(p.first).add(p.second);
    }
  return refs.filter((ref) => !implied.has(ref));
}

// Value index over every key-like column, self-joined to count shared values for
// each column pair (exact and ignoring case), in one executor call. Integer columns
// only pair with columns for a similar noun, which the join enforces so serial ids
// never multiply out across unrelated tables.
async function overlap(
  store: Store,
  scope: string,
  cols: Col[],
  declared: Set<string>,
) {
  // Adaptive value budget: total work stays ~constant no matter how many tables
  // connect (2M values across all key columns; at test scale the cap never bites).
  // LIMIT short-circuits each scan once its share is found. Dense categorical keys
  // (country, status, type codes) repeat inside any slice and still overlap; rare
  // IDs may be missed at very large scale (acceptable: same-system ID joins are
  // already captured by schema and declared keys).
  const perCol = Math.max(500, Math.floor(2_000_000 / cols.length));
  const values = cols
    .map((c) => {
      const e = c.field
        ? `struct_extract(${q(c.column)}, ${lit(c.field)})`
        : q(c.column);
      return `(SELECT ${c.i} AS c, ${c.ds.index} AS d, ${c.integer ? 1 : 0} AS i, ${lit(stem(c).slice(0, 3))} AS s, CAST(${e} AS VARCHAR) AS v FROM ${q(datasetTable(c.ds.d.id))} WHERE ${e} IS NOT NULL LIMIT ${perCol})`;
    })
    .join(" UNION ALL ");
  const pairs = [...declared].map((p) => p.split(":").map(Number));
  // Declared keys pair whatever their names.
  const matching = (t: string, agg: string) =>
    [
      `SELECT a.c AS a, b.c AS b, ${agg} FROM ${t} a JOIN ${t} b ON a.v = b.v AND a.d <> b.d AND a.i = 0 AND b.i = 0 GROUP BY a.c, b.c`,
      `SELECT a.c AS a, b.c AS b, ${agg} FROM ${t} a JOIN ${t} b ON a.v = b.v AND a.s = b.s AND a.d <> b.d AND (a.i = 1 OR b.i = 1) GROUP BY a.c, b.c`,
      ...(pairs.length
        ? [
            `SELECT a.c AS a, b.c AS b, ${agg} FROM (SELECT * FROM ${t} WHERE c IN (${pairs.map((p) => p[0]).join(", ")})) a JOIN (SELECT * FROM ${t} WHERE c IN (${pairs.map((p) => p[1]).join(", ")})) b ON a.v = b.v AND a.d <> b.d AND a.s <> b.s AND (a.i = 1 OR b.i = 1) WHERE ${pairs.map(([x, y]) => `(a.c = ${x} AND b.c = ${y})`).join(" OR ")} GROUP BY a.c, b.c`,
          ]
        : []),
    ].join(" UNION ALL ");
  const sql = `WITH vals AS (SELECT c, d, i, s, v FROM (${values}) AS x WHERE trim(v) <> ''),
ex AS (SELECT c, d, i, s, v, count(*) AS n FROM vals GROUP BY c, d, i, s, v),
ci AS (SELECT c, d, i, s, lower(trim(v)) AS v, count(*) AS n FROM vals GROUP BY c, d, i, s, lower(trim(v))),
cnt AS (SELECT c, count(*) AS d_exact, sum(n) AS rows_nonnull FROM ex GROUP BY c),
cnt_ci AS (SELECT c, count(*) AS d_ci FROM ci GROUP BY c),
pe AS (${matching("ex", "count(*) AS m_exact, sum(a.n) AS a_rows_exact")}),
pc AS (${matching("ci", "count(*) AS m_ci, sum(a.n) AS a_rows_ci")})
SELECT pc.a, pc.b, coalesce(pe.m_exact, 0) AS m_exact, pc.m_ci, coalesce(pe.a_rows_exact, 0) AS a_rows_exact, pc.a_rows_ci,
  ca.d_exact AS a_distinct, cca.d_ci AS a_distinct_ci, ca.rows_nonnull AS a_rows
FROM pc LEFT JOIN pe ON pe.a = pc.a AND pe.b = pc.b
JOIN cnt ca ON ca.c = pc.a JOIN cnt_ci cca ON cca.c = pc.a JOIN cnt_ci ccb ON ccb.c = pc.b
WHERE pc.m_ci >= 0.5 * least(cca.d_ci, ccb.d_ci) OR pc.m_ci >= 20${pairs.map(([x, y]) => ` OR (pc.a = ${x} AND pc.b = ${y})`).join("")}
ORDER BY pc.m_ci DESC, pc.a, pc.b`;
  const ids = [...new Set(cols.map((c) => c.ds.d.id))];
  // The executor returns at most 1000 rows a call.
  const rows: Record<string, unknown>[] = [];
  for (let total = Infinity; rows.length < total; ) {
    const r = await queryDatasets(store, scope, ids, sql, {
      limit: 1000,
      offset: rows.length,
    });
    total = Number(r.profile?.rows ?? r.rows.length);
    if (!r.rows.length) break;
    rows.push(...r.rows);
  }
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, Number(v)]),
      ) as Record<
        | "a"
        | "b"
        | "m_exact"
        | "m_ci"
        | "a_rows_exact"
        | "a_rows_ci"
        | "a_distinct"
        | "a_distinct_ci"
        | "a_rows",
        number
      >,
  );
}

function linkName(column: string) {
  const c = column.toLowerCase();
  if (/requester|reporter|submitted_by|author/.test(c)) return "requested by";
  if (/campaign|utm/.test(c)) return "came from";
  if (/subscription/.test(c)) return "for subscription";
  if (/customer|billing/.test(c)) return "billed to";
  if (
    /account|organi[sz]ation|(^|_)org(_|$)|company|tenant|workspace|team/.test(
      c,
    )
  )
    return "belongs to";
  if (/owner/.test(c)) return "owned by";
  if (/user|distinct_id|person|actor|member/.test(c)) return "performed by";
  return "references";
}

// Output columns of an entity: the anchor's columns, then each merged dataset's
// columns prefixed with its system (workos_name), skipping the join column.
