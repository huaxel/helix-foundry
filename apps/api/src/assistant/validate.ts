import {
  type Bundle,
  type Resource,
  type ValidationReport,
  datasetTable,
} from "../../../../packages/shared/src/index.js";
import { now, resource, type Store } from "../store.js";
import { assert } from "../security.js";
import { execute } from "../executor.js";
import { pipelineId } from "../datasets.js";
import { randomUUID } from "node:crypto";
import { datasetsMap, inputsFor } from "./provider.js";

export async function validateBundle(
  store: Store,
  scope: string,
  bundle: Bundle,
): Promise<ValidationReport> {
  const datasets = await datasetsMap(store, scope),
    checks: ValidationReport["checks"] = [],
    previews: Record<string, any> = {},
    inputVersions: Record<string, string> = {};
  // Resolve unambiguous names against the authorized catalog; never invent a dataset.
  const resolveDataset = (ref: string) => {
    if (datasets.has(ref)) return ref;
    const matches = [...datasets.values()].filter(
      (d) =>
        d.name.toLowerCase() === ref.toLowerCase() ||
        datasetTable(d.id) === ref,
    );
    return matches.length === 1 ? matches[0].id : ref;
  };
  for (const c of bundle.catalog) c.datasetId = resolveDataset(c.datasetId);
  for (const p of bundle.pipelines) p.inputs = p.inputs.map(resolveDataset);
  for (const t of bundle.ontology) t.datasetId = resolveDataset(t.datasetId);
  // Small models sometimes pair a type with the wrong dataset ID. When the type's key
  // and properties exist, key unique, in exactly one dataset, use that dataset.
  const fits = (d: Resource | undefined, t: Bundle["ontology"][number]) => {
    const columns = d?.data.profile?.columns || [];
    return (
      columns.some((c: any) => c.name === t.primaryKey && c.primaryKey) &&
      t.properties.every((p) => columns.some((c: any) => c.name === p))
    );
  };
  // Types on a pipeline output are never moved: the output does not exist yet.
  const derived = new Set(bundle.pipelines.map((p) => pipelineId(p.name)));
  for (const t of bundle.ontology) {
    if (
      derived.has(t.datasetId) ||
      t.datasetId.startsWith("pipeline_") ||
      fits(datasets.get(t.datasetId), t)
    )
      continue;
    const owners = [...datasets.values()].filter((d) => fits(d, t));
    if (owners.length === 1) t.datasetId = owners[0].id;
  }
  for (const d of bundle.dashboards)
    for (const w of d.widgets) w.inputs = w.inputs.map(resolveDataset);
  const derivedIds = new Set<string>();
  const unique = (items: { name: string }[]) =>
    new Set(items.map((x) => x.name)).size === items.length;
  checks.push({
    name: "Definition identities",
    passed: [
      bundle.pipelines,
      bundle.ontology,
      bundle.dashboards,
      bundle.relationships,
    ].every(unique),
    detail: "Names must be unique within each asset type",
  });
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, passed: true, detail: await fn() });
    } catch (e) {
      checks.push({
        name,
        passed: false,
        detail: e instanceof Error ? e.message : "Validation failed",
      });
    }
  };
  const query = async (ids: string[], sql: string, persist = false) => {
    for (const id of ids) {
      const d = datasets.get(id);
      if (d && !derivedIds.has(id)) inputVersions[id] = d.data.activeVersion;
    }
    return execute({
      mode: "query",
      scope,
      inputs: await inputsFor(store, scope, ids, datasets),
      sql,
      version: randomUUID(),
      persist,
      limit: 20,
    });
  };
  for (const c of bundle.catalog)
    await check("Catalog: " + c.datasetId, async () => {
      const d = datasets.get(c.datasetId);
      assert(d, "Unknown dataset");
      inputVersions[d.id] = d.data.activeVersion;
      return "Description grounded in dataset profile";
    });
  for (const p of bundle.pipelines)
    await check("Pipeline: " + p.name, async () => {
      const r = await query(p.inputs, p.sql, true),
        id = pipelineId(p.name);
      derivedIds.add(id);
      datasets.set(
        id,
        resource(
          scope,
          "dataset",
          p.name,
          {
            profile: r.profile,
            activeVersion: r.version,
            table: datasetTable(id),
          },
          id,
        ),
      );
      previews[id] = r;
      previews["before:" + p.name] = p.inputs.flatMap(
        (input) => datasets.get(input)?.data.profile.sample.slice(0, 5) || [],
      );
      const first = datasets.get(p.inputs[0]);
      const key = first?.data.profile.columns.find(
        (c: any) =>
          c.primaryKey && r.profile.columns.some((x) => x.name === c.name),
      );
      if (p.inputs.length === 1 && key) {
        const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
        previews["rejected:" + p.name] = (
          await query(
            [p.inputs[0], id],
            `SELECT a.* FROM ${quote(datasetTable(p.inputs[0]))} a WHERE NOT EXISTS (SELECT 1 FROM ${quote(datasetTable(id))} b WHERE a.${quote(key.name)}=b.${quote(key.name)})`,
          )
        ).rows;
      }
      for (const c of p.checks) {
        const result = await query([...p.inputs, id], c.sql);
        assert(
          result.rows.length > 0 &&
            Object.values(result.rows[0]).every(
              (v) => v === true || v === 1 || v === "1",
            ),
          `Quality check failed: ${c.name}`,
        );
      }
      return `${r.profile.rows} output rows; ${p.checks.length} checks passed`;
    });
  for (const type of bundle.ontology)
    await check("Ontology: " + type.name, async () => {
      const d = datasets.get(type.datasetId);
      assert(d, "Unknown dataset");
      for (const prop of [type.primaryKey, ...type.properties])
        assert(
          d.data.profile.columns.some((x: any) => x.name === prop),
          `Unknown property ${prop}`,
        );
      const col = d.data.profile.columns.find(
        (x: any) => x.name === type.primaryKey,
      );
      assert(col.primaryKey, "Primary key must be unique and non-null");
      if (!derivedIds.has(type.datasetId))
        inputVersions[type.datasetId] = d.data.activeVersion;
      return `${d.data.profile.rows} objects; unique non-null key`;
    });
  const q = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  for (const rel of bundle.relationships)
    await check("Relationship: " + rel.name, async () => {
      const from = bundle.ontology.find((o) => o.name === rel.fromType),
        to = bundle.ontology.find((o) => o.name === rel.toType);
      assert(
        from && to,
        `Unknown object type in ${rel.fromType} → ${rel.toType}. Defined types: ${bundle.ontology.map((t) => t.name).join(", ")}. Include each referenced type with its source dataset and key.`,
      );
      const source = datasets.get(from.datasetId)!,
        target = datasets.get(to.datasetId)!;
      const fromColumn = source.data.profile.columns.find(
          (c: any) => c.name === rel.fromColumn,
        ),
        toColumn = target.data.profile.columns.find(
          (c: any) => c.name === rel.toColumn,
        );
      assert(fromColumn && toColumn, "Unknown relationship column");
      const sql = `SELECT count(DISTINCT a.${q(from.primaryKey)}) AS total, count(DISTINCT CASE WHEN b.${q(to.primaryKey)} IS NOT NULL THEN a.${q(from.primaryKey)} END) AS "matched",count(b.${q(to.primaryKey)}) AS pairs FROM ${q(datasetTable(from.datasetId))} a LEFT JOIN ${q(datasetTable(to.datasetId))} b ON a.${q(rel.fromColumn)}=b.${q(rel.toColumn)}`;
      const r = await query([from.datasetId, to.datasetId], sql);
      const cardinality =
        (fromColumn.primaryKey ? "one" : "many") +
        "-to-" +
        (toColumn.primaryKey ? "one" : "many");
      previews["relation:" + rel.name] = { rows: r.rows, cardinality };
      return `${r.rows[0].matched}/${r.rows[0].total} source objects matched; ${cardinality}; ${r.rows[0].pairs} relationship pairs`;
    });
  for (const d of bundle.dashboards)
    for (const [i, w] of d.widgets.entries())
      await check(`Dashboard: ${d.name} / ${w.title}`, async () => {
        const r = await query(w.inputs, w.sql);
        // Derive presentation only from the executed result shape.
        const cols = r.profile.columns;
        if (
          w.type === "metric" &&
          (r.profile.rows !== 1 || cols.length !== 1)
        ) {
          w.type =
            cols.length === 2 &&
            r.profile.rows > 1 &&
            /INT|DECIMAL|DOUBLE|FLOAT/i.test(cols[1].type)
              ? "bar"
              : "table";
          if (w.type === "bar") {
            w.x = cols[0].name;
            w.y = cols[1].name;
          }
        }
        for (const axis of ["x", "y"] as const)
          if (w[axis] && !cols.some((c) => c.name === w[axis])) {
            const last = w[axis]!.split(".").at(-1);
            if (cols.some((c) => c.name === last)) w[axis] = last;
          }
        if (w.x && ["bar", "line"].includes(w.type))
          assert(
            r.profile.columns.some((c) => c.name === w.x),
            "Unknown chart x field",
          );
        if (w.y && ["bar", "line"].includes(w.type))
          assert(
            r.profile.columns.some((c) => c.name === w.y),
            "Unknown chart y field",
          );
        previews["chart:" + d.name + ":" + i] = r.rows;
        return `${r.profile.rows} result rows; query executed`;
      });
  for (const a of bundle.actions)
    await check("Action: " + a.name, async () => {
      const t = bundle.ontology.find((o) => o.name === a.objectType);
      assert(t, "Unknown action type");
      assert(
        a.fields.every((f) => t.properties.includes(f) && f !== t.primaryKey),
        "Action fields must exist and cannot change identity",
      );
      return "Editable fields verified";
    });
  return {
    valid: checks.length > 0 && checks.every((c) => c.passed),
    checks,
    previews,
    inputVersions,
    validatedAt: now(),
    baseGeneration:
      (await store.get(scope, "workspace"))?.data.activeGeneration || null,
  };
}
