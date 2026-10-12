import {
  type Bundle,
  type ColumnProfile,
  datasetTable,
  type Resource,
  type SuggestedEntity,
  type SuggestedOntology,
} from "../../../../packages/shared/src/index.js";
import { pipelineId } from "../datasets.js";
import { assert } from "../security.js";
import { entityColumn, entityColumns } from "./columns.js";
import {
  datasetLabel,
  entityName,
  lit,
  lowerFirst,
  plural,
  q,
  slug,
  sourceLabel,
  tableName,
} from "./names.js";

export function ontologyBundle(
  o: SuggestedOntology,
  datasets: Map<string, Resource>,
): Pick<
  Bundle,
  | "summary"
  | "assumptions"
  | "catalog"
  | "pipelines"
  | "ontology"
  | "relationships"
> {
  const records = o.entities
    .filter(
      (e) =>
        e.kind === "record" &&
        e.members.every((m) => datasets.has(m.datasetId)),
    )
    .slice(0, 20);
  const byId = new Map(records.map((e) => [e.id, e]));
  const type = (datasetId: string, column: string) =>
    datasets
      .get(datasetId)
      ?.data.profile.columns.find((c: ColumnProfile) => c.name === column)
      ?.type;
  const outputType = (e: SuggestedEntity, as: string) =>
    entityColumns(e, datasets).find((c) => c.as === as)?.type;
  const planned = o.links.flatMap((l) => {
    const from = byId.get(l.from),
      to = byId.get(l.to);
    const fromColumn =
        from && entityColumn(from, datasets, l.fromDatasetId, l.fromColumn),
      toColumn = to && entityColumn(to, datasets, l.toDatasetId, l.toColumn);
    if (!from || !to || !fromColumn || !toColumn) return [];
    const normalize =
      l.caseInsensitive ||
      outputType(from, fromColumn) !== outputType(to, toColumn);
    return [{ l, from, to, fromColumn, toColumn, normalize }];
  });
  const keysFor = new Map<string, Set<string>>();
  for (const p of planned)
    if (p.normalize)
      for (const [e, c] of [
        [p.from, p.fromColumn],
        [p.to, p.toColumn],
      ] as const)
        keysFor.set(e.id, new Set([...(keysFor.get(e.id) || []), c]));
  const piped = new Set(
    records
      .filter((e) => e.members.length > 1)
      .slice(0, 10)
      .map((e) => e.id),
  );
  for (const e of records)
    if (keysFor.has(e.id) && piped.size < 10) piped.add(e.id);
  const pipelines: Bundle["pipelines"] = [],
    ontology: Bundle["ontology"] = [],
    available = new Map<string, Set<string>>(),
    keyColumns = new Map<string, Map<string, string>>();
  for (const e of records) {
    const anchorOnly = {
      anchorDatasetId: e.anchorDatasetId,
      members: e.members.filter((m) => m.datasetId === e.anchorDatasetId),
    };
    const cols = entityColumns(piped.has(e.id) ? e : anchorOnly, datasets);
    const names = new Set(cols.map((c) => c.as));
    let datasetId = e.anchorDatasetId;
    if (piped.has(e.id)) {
      const alias = new Map(e.members.map((m, i) => [m.datasetId, `m${i}`]));
      alias.set(e.anchorDatasetId, "a");
      const keys = new Map<string, string>(),
        select = cols.map(
          (c) =>
            `${alias.get(c.datasetId)}.${q(c.column)}` +
            (c.as === c.column ? "" : ` AS ${q(c.as)}`),
        );
      for (const as of keysFor.get(e.id) || []) {
        const c = cols.find((x) => x.as === as)!;
        let key = `${as}_key`;
        for (
          let n = 2;
          [...names].some((x) => x.toLowerCase() === key.toLowerCase());
          n++
        )
          key = `${as}_key_${n}`;
        names.add(key);
        keys.set(as, key);
        select.push(
          `lower(trim(CAST(${alias.get(c.datasetId)}.${q(c.column)} AS VARCHAR))) AS ${q(key)}`,
        );
      }
      keyColumns.set(e.id, keys);
      const joined = new Set([e.anchorDatasetId]),
        joins: string[] = [];
      for (let grew = true; grew; ) {
        grew = false;
        for (const m of e.members)
          if (
            m.via &&
            !joined.has(m.datasetId) &&
            joined.has(m.via.targetDatasetId)
          ) {
            const cast =
              type(m.datasetId, m.via.column) !==
              type(m.via.targetDatasetId, m.via.targetColumn);
            const side = (a: string, c: string) =>
              cast ? `CAST(${a}.${q(c)} AS VARCHAR)` : `${a}.${q(c)}`;
            joins.push(
              `LEFT JOIN ${q(datasetTable(m.datasetId))} ${alias.get(m.datasetId)} ON ${side(alias.get(m.datasetId)!, m.via.column)} = ${side(alias.get(m.via.targetDatasetId)!, m.via.targetColumn)}`,
            );
            joined.add(m.datasetId);
            grew = true;
          }
      }
      const name = `${plural(e.name)} (${[...new Set(e.members.filter((m) => joined.has(m.datasetId)).map((m) => sourceLabel(m.source)))].join(" + ")})`;
      datasetId = pipelineId(name);
      pipelines.push({
        name,
        description: e.description,
        inputs: [...joined],
        sql: `SELECT ${select.join(", ")} FROM ${q(datasetTable(e.anchorDatasetId))} a ${joins.join(" ")}`.trim(),
        nodes: [],
        checks: [
          {
            name: `One row per ${lowerFirst(e.name)}`,
            sql: `SELECT count(*) = count(DISTINCT ${q(e.key)}) AND count(${q(e.key)}) = count(*) AS ok FROM ${q(datasetTable(datasetId))}`,
          },
        ],
      });
    }
    available.set(e.id, names);
    ontology.push({
      name: e.name,
      datasetId,
      primaryKey: e.key,
      properties: [
        ...new Set([e.key, ...e.properties.filter((p) => names.has(p))]),
      ],
      description: e.description,
    });
  }
  const relationships: Bundle["relationships"] = [];
  for (const p of planned) {
    const fromColumn = p.normalize
        ? keyColumns.get(p.from.id)?.get(p.fromColumn)
        : p.fromColumn,
      toColumn = p.normalize
        ? keyColumns.get(p.to.id)?.get(p.toColumn)
        : p.toColumn;
    if (
      !fromColumn ||
      !toColumn ||
      !available.get(p.from.id)!.has(fromColumn) ||
      !available.get(p.to.id)!.has(toColumn)
    )
      continue;
    relationships.push({
      name: p.l.name,
      fromType: p.from.name,
      toType: p.to.name,
      fromColumn,
      toColumn,
    });
  }
  // Relationship names are identities, so repeated verbs name their subject.
  const repeated = (r: (typeof relationships)[number]) =>
    relationships.filter((x) => x.name === r.name).length > 1;
  const named = relationships.map((r) =>
    repeated(r) ? { ...r, name: `${r.fromType} ${r.name}` } : { ...r },
  );
  const seen = new Set<string>();
  for (const r of named) {
    const base = seen.has(r.name) ? `${r.name} ${r.toType}` : r.name;
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base} ${n}`;
    seen.add(name);
    r.name = name;
  }
  const catalog = [
    ...o.entities.flatMap((e) =>
      e.members
        .filter((m) => datasets.has(m.datasetId))
        .map((m) => ({
          datasetId: m.datasetId,
          description:
            datasets.get(m.datasetId)!.description ||
            `${datasetLabel({ source: m.source, table: tableName(m.datasetName, m.source) })}: ${e.name} ${e.kind === "activity" ? "activity" : "records"}.`,
          tags: [slug(e.name), m.source],
        })),
    ),
    // Tables outside the schema still feed dashboards.
    ...o.unplaced.flatMap((id) => {
      const d = datasets.get(id);
      return d
        ? [
            {
              datasetId: id,
              description: d.description || `${d.name}: rows kept as a table.`,
              tags: [slug(tableName(d.name, d.data.sampleSource || ""))],
            },
          ]
        : [];
    }),
  ];
  return {
    summary: o.summary,
    assumptions: o.notes
      .filter((n) => n.kind === "case" || n.kind === "unmatched")
      .map((n) =>
        n.kind === "case"
          ? `${n.text} They are linked on lower-cased values.`
          : n.text,
      ),
    catalog,
    pipelines,
    ontology,
    relationships: named.slice(0, 30),
  };
}

// A dashboard computed from a confirmed ontology, for a build whose model-designed
// widgets all fail: the hub entity's records, records per entity, and new records
// per month. Plain counts over the source tables, so it validates without a model.
export function overviewDashboard(
  o: SuggestedOntology,
  datasets: Map<string, Resource>,
): Bundle["dashboards"][number] {
  const degree = (e: SuggestedEntity) =>
    o.links.filter((l) => l.from === e.id || l.to === e.id).length;
  const records = o.entities
    .filter((e) => e.kind === "record" && datasets.has(e.anchorDatasetId))
    .sort((a, b) => degree(b) - degree(a))
    .slice(0, 20);
  // Without records, each table counts for itself.
  const groups = (
    records.length
      ? records.map((e) => ({
          name: plural(e.name),
          datasetId: e.anchorDatasetId,
        }))
      : [...datasets.values()].map((d) => ({
          name: plural(
            entityName(tableName(d.name, d.data.sampleSource || "")),
          ),
          datasetId: d.id,
        }))
  ).slice(0, 20);
  assert(groups.length, "Connect or upload a dataset first");
  const from = (id: string) => q(datasetTable(id));
  const counts = groups
    .map(
      (g) =>
        `SELECT ${lit(g.name)} AS "type", count(*) AS "records" FROM ${from(g.datasetId)}`,
    )
    .join(" UNION ALL ");
  const inputs = [...new Set(groups.map((g) => g.datasetId))];
  const widgets: Bundle["dashboards"][number]["widgets"] = [
    records.length
      ? {
          title: groups[0].name,
          type: "metric",
          sql: `SELECT count(*) AS "records" FROM ${from(groups[0].datasetId)}`,
          inputs: [groups[0].datasetId],
        }
      : {
          title: "Records",
          type: "metric",
          sql: `SELECT CAST(sum("records") AS BIGINT) AS "records" FROM (${counts})`,
          inputs,
        },
  ];
  if (groups.length > 1)
    widgets.push({
      title: "Records by type",
      type: "bar",
      sql: `SELECT * FROM (${counts}) ORDER BY "records" DESC, "type"`,
      inputs,
      x: "type",
      y: "records",
    });
  const temporal = (c: ColumnProfile) => /^(DATE|TIMESTAMP)/i.test(c.type);
  const dated = [/creat/i, /date|start|sign.?up|joined/i]
    .flatMap((pattern) =>
      records.flatMap((e) => {
        const c = datasets
          .get(e.anchorDatasetId)!
          .data.profile?.columns.find(
            (c: ColumnProfile) => temporal(c) && pattern.test(c.name),
          );
        return c ? [{ e, column: q(c.name) }] : [];
      }),
    )
    .at(0);
  if (dated)
    widgets.push({
      title: `New ${plural(lowerFirst(dated.e.name))} per month`,
      type: "line",
      sql: `SELECT strftime(CAST(${dated.column} AS TIMESTAMP), '%Y-%m') AS "month", count(*) AS "records" FROM ${from(dated.e.anchorDatasetId)} WHERE ${dated.column} IS NOT NULL GROUP BY 1 ORDER BY 1`,
      inputs: [dated.e.anchorDatasetId],
      x: "month",
      y: "records",
    });
  return { name: "Overview", description: o.summary, widgets };
}
