import {
  BundleSchema,
  type Bundle,
  type Resource,
  type ValidationReport,
  datasetTable,
} from "../../../../packages/shared/src/index.js";
import { assertOnboardingPublication } from "../onboarding-state.js";
import { now, resource, transaction, type Store } from "../store.js";
import { assert, digest } from "../security.js";
import { execute } from "../executor.js";
import { pipelineId } from "../datasets.js";
import { randomUUID } from "node:crypto";
import { datasetsMap, inputsFor, proposalHash } from "./provider.js";
import { validateBundle } from "./validate.js";

export async function saveProposal(
  store: Store,
  scope: string,
  bundle: Bundle,
  parentId?: string,
) {
  const report = await validateBundle(store, scope, bundle);
  return transaction(store, scope, async (tx) => {
    const parent = parentId ? await tx.get(parentId) : undefined;
    const p = tx.put(
      resource(scope, "proposal", bundle.summary.slice(0, 90), {
        bundle,
        validation: report,
        status: report.valid ? "ready" : "draft",
        hash: proposalHash(bundle, report),
        parentId,
        ...(parent?.data.onboardingSignature
          ? {
              onboardingSignature: parent.data.onboardingSignature,
              onboardingRunId: parent.data.onboardingRunId,
            }
          : {}),
      }),
    );
    if (parent?.data.onboardingRunId) {
      const run = await tx.get(parent.data.onboardingRunId);
      if (run && run.data.proposalId === parentId)
        tx.update(run, { ...run.data, proposalId: p.id });
    }
    return p;
  });
}
export async function event(
  store: Store,
  scope: string,
  id: string,
  stage: string,
  message: string,
  extra: Record<string, any> = {},
) {
  return transaction(store, scope, async (tx) => {
    const r = await tx.get(id);
    assert(r, "Run missing");
    assert(r.data.status !== "canceled", "Run canceled", 409);
    return tx.update(r, {
      ...r.data,
      ...extra,
      stage,
      leaseUntil: Date.now() + 180000,
      events: [...r.data.events, { at: now(), stage, message }],
    });
  });
}
// A retry continues from the run's checkpoints with a fresh call budget.
export const retried = (data: Record<string, any>, message: string) => ({
  ...data,
  status: "queued",
  stage: "queued",
  error: null,
  retryAt: null,
  callsBefore: data.calls || 0,
  events: [...(data.events || []), { at: now(), stage: "queued", message }],
});
export async function publishProposal(
  store: Store,
  scope: string,
  id: string,
  hash: string,
  actor: string,
  message = "Reviewed workspace published",
  opts: { stageRecords?: boolean } = {},
) {
  const proposal = await store.get(scope, id);
  assert(proposal?.kind === "proposal", "Proposal not found", 404);
  if (proposal.data.status === "published") return proposal;
  assert(
    proposal.data.status === "ready" && proposal.data.validation.valid,
    "Proposal must pass validation",
  );
  assert(
    hash === proposal.data.hash,
    "Proposal changed; review its current version",
    409,
  );
  const report = proposal.data.validation as ValidationReport,
    bundle = BundleSchema.parse(proposal.data.bundle);
  for (const [datasetId, version] of Object.entries(report.inputVersions))
    assert(
      (await store.get(scope, datasetId))?.data.activeVersion === version,
      "Input data changed. Revalidate this proposal.",
      409,
    );
  const beforeGeneration = (await store.get(scope, "workspace"))?.data
    .activeGeneration;
  assert(
    (beforeGeneration || null) === (report.baseGeneration || null),
    "Published definitions changed. Revalidate this proposal.",
    409,
  );
  const generation = randomUUID(),
    map = await datasetsMap(store, scope);
  const assets: Resource[] = [];
  for (const p of bundle.pipelines) {
    const preview = report.previews[pipelineId(p.name)] as any;
    assert(preview?.version, "Missing pipeline output");
    const ds = resource(
      scope,
      "dataset",
      p.name,
      {
        activeVersion: preview.version,
        versions: [preview.version],
        profile: preview.profile,
        table: datasetTable(pipelineId(p.name)),
        generation,
      },
      pipelineId(p.name),
    );
    map.set(ds.id, ds);
    for (const input of p.inputs)
      assets.push(
        resource(scope, "lineage", p.name, {
          from: input,
          to: ds.id,
          generation,
          inputVersion: map.get(input)?.data.activeVersion,
        }),
      );
    assets.push(
      ds,
      resource(scope, "pipeline", p.name, {
        ...p,
        generation,
        outputDatasetId: ds.id,
      }),
      resource(
        scope,
        "version",
        p.name,
        {
          datasetId: ds.id,
          profile: preview.profile,
          file: preview.version + ".parquet",
        },
        preview.version,
      ),
    );
  }
  const identities = new Map<string, Map<string, string>>();
  const manualObjects = await store.list(scope, "manualObject");
  const relationEdits = await store.list(scope, "relationEdit");
  const edits = new Map(
    relationEdits.map((r) => [
      [r.data.fromLogicalId, r.data.toLogicalId, r.name].join(":"),
      r,
    ]),
  );
  // Row staging pages every record 500 at a time, and the executor
  // materializes the full table per page: at scale that never finishes, so
  // huge workspaces publish dashboard-only and query live instead.
  const stageRecords = opts.stageRecords !== false;
  for (const type of bundle.ontology) {
    const dataset = map.get(type.datasetId);
    assert(dataset, "Dataset unavailable");
    const typeId = digest(type.name).slice(0, 20),
      lookup = new Map<string, string>();
    identities.set(type.name, lookup);
    assets.push(
      resource(scope, "objectType", type.name, { ...type, generation, typeId }),
    );
    if (!stageRecords) continue;
    for (let offset = 0; offset < dataset.data.profile.rows; offset += 500) {
      const r = await execute({
        mode: "query",
        scope,
        inputs: await inputsFor(store, scope, [type.datasetId], map),
        sql: `SELECT * FROM "${datasetTable(type.datasetId)}"`,
        version: randomUUID(),
        offset,
        limit: 500,
      });
      const staged = r.rows.map((row) => {
        const key = String(row[type.primaryKey]),
          logicalId = digest(typeId + ":" + key).slice(0, 32),
          obj = resource(
            scope,
            "object",
            `${type.name} ${key}`,
            {
              type: type.name,
              typeId,
              key,
              logicalId,
              generation,
              base: row,
              sourceVersion: dataset.data.activeVersion,
            },
            generation + "_" + logicalId,
          );
        lookup.set(key, obj.id);
        return obj;
      });
      await transaction(store, scope, async (tx) => {
        staged.forEach((o) => tx.put(o));
      });
    }
  }
  for (const o of manualObjects) {
    const lookup = identities.get(o.data.type);
    if (lookup && !lookup.has(o.data.key)) {
      const staged = resource(
        scope,
        "object",
        o.name,
        { ...o.data, generation },
        generation + "_" + o.data.logicalId,
      );
      lookup.set(o.data.key, staged.id);
      await transaction(store, scope, async (tx) => tx.put(staged));
    }
  }
  const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  for (const rel of bundle.relationships) {
    // Without staged records there are no identities to link, and the join
    // itself would scan both tables for nothing.
    if (!stageRecords) continue;
    const fromType = bundle.ontology.find((o) => o.name === rel.fromType)!,
      toType = bundle.ontology.find((o) => o.name === rel.toType)!;
    const sql = `SELECT a.${quote(fromType.primaryKey)} AS from_key,b.${quote(toType.primaryKey)} AS to_key FROM ${quote(datasetTable(fromType.datasetId))} a JOIN ${quote(datasetTable(toType.datasetId))} b ON a.${quote(rel.fromColumn)}=b.${quote(rel.toColumn)}`;
    let offset = 0,
      total = Infinity;
    while (offset < total) {
      const r = await execute({
        mode: "query",
        scope,
        inputs: await inputsFor(
          store,
          scope,
          [fromType.datasetId, toType.datasetId],
          map,
        ),
        sql,
        version: randomUUID(),
        offset,
        limit: 500,
      });
      total = r.profile.rows;
      await transaction(store, scope, async (tx) => {
        for (const row of r.rows) {
          const from = identities.get(rel.fromType)!.get(String(row.from_key)),
            to = identities.get(rel.toType)!.get(String(row.to_key));
          const edit =
            from && to
              ? edits.get(
                  [
                    from.slice(generation.length + 1),
                    to.slice(generation.length + 1),
                    rel.name,
                  ].join(":"),
                )
              : undefined;
          if (from && to && !edit)
            tx.put(
              resource(scope, "relation", rel.name, { from, to, generation }),
            );
        }
      });
      offset += 500;
    }
  }
  for (const edit of relationEdits) {
    const from = generation + "_" + edit.data.fromLogicalId,
      to = generation + "_" + edit.data.toLogicalId;
    if (
      edit.data.enabled &&
      (await store.get(scope, from)) &&
      (await store.get(scope, to))
    )
      await transaction(store, scope, async (tx) =>
        tx.put(
          resource(scope, "relation", edit.name, { from, to, generation }),
        ),
      );
  }
  for (const asset of assets)
    if (asset.kind === "objectType")
      asset.data.objectCount = stageRecords
        ? identities.get(asset.name)?.size || 0
        : map.get(
            bundle.ontology.find((o) => o.name === asset.name)?.datasetId ||
              "",
          )?.data.profile.rows || 0;
  for (const d of bundle.dashboards)
    assets.push(resource(scope, "dashboard", d.name, { ...d, generation }));
  for (const a of bundle.actions)
    assets.push(resource(scope, "actionType", a.name, { ...a, generation }));
  // HelixDB cannot plan a single commit with hundreds of mutations, so stage
  // the assets in bounded chunks first. Every asset has a stable id, so a
  // retry overwrites rather than duplicates, and activation stays in the
  // final transaction below (which still guards on input versions).
  for (const c of bundle.catalog) {
    const ds = await store.get(scope, c.datasetId);
    if (ds && !ds.data.manualDescription)
      assets.push({
        ...ds,
        description: c.description,
        revision: ds.revision + 1,
        data: { ...ds.data, tags: c.tags },
      });
  }
  for (let i = 0; i < assets.length; i += 100)
    await transaction(store, scope, async (tx) => {
      for (const asset of assets.slice(i, i + 100)) tx.put(asset);
    });
  return transaction(store, scope, async (tx) => {
    const p = await tx.get(id);
    assert(
      p?.data.hash === hash && p.data.status === "ready",
      "Proposal changed during publication",
      409,
    );
    for (const [datasetId, v] of Object.entries(report.inputVersions))
      assert(
        (await tx.get(datasetId))?.data.activeVersion === v,
        "Inputs changed during publication",
        409,
      );
    const workspace = await tx.get("workspace");
    assert(workspace, "Workspace missing");
    await assertOnboardingPublication(tx, p);
    assert(
      workspace.data.activeGeneration === beforeGeneration,
      "Another proposal was published. Revalidate this proposal.",
      409,
    );
    const membership = await store.get("global", `${actor}:${scope}`);
    assert(
      membership && ["owner", "editor"].includes(membership.data.role),
      "Publish permission changed",
      403,
    );
    tx.update(workspace, {
      ...workspace.data,
      activeGeneration: generation,
      previousGeneration: workspace.data.activeGeneration || null,
      ...(p.data.onboardingSignature
        ? {
            onboarding: {
              ...workspace.data.onboarding,
              completedAt: now(),
              completedGeneration: generation,
              dashboardId: assets.find((a) => a.kind === "dashboard")?.id,
              step: "review",
              deferred: false,
            },
          }
        : {}),
    });
    tx.put(
      resource(scope, "publication", proposal.name, {
        generation,
        previousGeneration: workspace.data.activeGeneration || null,
        proposalId: id,
        actor,
      }),
    );
    for (const run of await tx.list("run"))
      if (
        run.data.proposalId &&
        run.data.status !== "canceled" &&
        [id, p.data.parentId].includes(run.data.proposalId)
      )
        tx.update(run, {
          ...run.data,
          status: "succeeded",
          stage: "published",
          proposalId: id,
          events: [
            ...run.data.events,
            {
              at: now(),
              stage: "published",
              message,
            },
          ],
        });
    tx.put(
      resource(scope, "audit", "Published workspace", {
        actor,
        proposalId: id,
        generation,
      }),
    );
    return tx.update(p, {
      ...p.data,
      status: "published",
      publishedGeneration: generation,
    });
  });
}

export async function currentBundle(
  store: Store,
  scope: string,
): Promise<Bundle> {
  const generation = (await store.get(scope, "workspace"))?.data
    .activeGeneration;
  const published = (await store.list(scope, "proposal")).find(
    (p) => p.data.publishedGeneration === generation,
  );
  return BundleSchema.parse(
    published?.data.bundle || {
      summary: "Workspace definitions",
      assumptions: [],
      catalog: [],
      pipelines: [],
      ontology: [],
      relationships: [],
      dashboards: [],
      actions: [],
    },
  );
}
