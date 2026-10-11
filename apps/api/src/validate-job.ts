import type { Resource } from "../../../packages/shared/src/index.js";
import { datasetTable } from "../../../packages/shared/src/index.js";
import { queryDatasets } from "./datasets.js";
import { jobProgress } from "./setup-jobs.js";
import { transaction, type Store } from "./store.js";

// Background validation of curated catalog links: sampled existence checks
// confirm each asserted join actually resolves to overlapping values. Suspect
// links (no match in the sample) get advisory notes; verified links need no
// marker. Advisory only: never blocks, drops, or re-hashes the suggestion
// (notes are outside the confirm hash). Chunked so each executor call stays
// small; per-batch indexes are offset back to global link indexes.
const SAMPLE_ROWS = 20000;
const BATCH = 20;
export async function runValidateJob(
  store: Store,
  scope: string,
  job: Resource,
): Promise<unknown> {
  const { onboardingSignature } = (job.data || {}) as {
    onboardingSignature?: string;
  };
  const workspace = await store.get(scope, "workspace");
  const suggestion = workspace?.data?.onboarding?.ontologySuggestion;
  if (!suggestion || !onboardingSignature) return null;
  if (suggestion.signature !== onboardingSignature) return null;
  const curated = (suggestion.links as any[]).filter((l) =>
    String(l.id || "").startsWith("catalog-"),
  );
  if (!curated.length) return null;
  const q = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const branches = curated.map(
    (l, i) =>
      `SELECT ${i} AS k FROM (SELECT CAST(${q(l.fromColumn)} AS VARCHAR) AS v FROM ${q(datasetTable(l.fromDatasetId))} USING SAMPLE ${SAMPLE_ROWS} ROWS WHERE ${q(l.fromColumn)} IS NOT NULL) a JOIN (SELECT CAST(${q(l.toColumn)} AS VARCHAR) AS v FROM ${q(datasetTable(l.toDatasetId))} USING SAMPLE ${SAMPLE_ROWS} ROWS WHERE ${q(l.toColumn)} IS NOT NULL) b ON a.v = b.v LIMIT 1`,
  );
  const ids = [...new Set(curated.flatMap((l) => [l.fromDatasetId, l.toDatasetId]))];
  const entitiesById = new Map(
    (((suggestion as any).entities as any[]) || []).map((e: any) => [e.id, e.name]),
  );
  // Columns included so distinct pairs between the same entities flag separately.
  const noteFor = (l: any) =>
    `${entitiesById.get(l.from) || l.from}.${l.fromColumn} → ${entitiesById.get(l.to) || l.to}.${l.toColumn} (catalog) shows no matching rows in a 20,000-row sample; the catalog key may be stale or very sparse.`;
  let suspect = 0;
  for (let start = 0; start < branches.length; start += BATCH) {
    const slice = branches.slice(start, start + BATCH);
    const r = await queryDatasets(store, scope, ids, slice.join(" UNION ALL "), {
      limit: 1000,
    });
    const seen = new Set((r.rows as any[]).map((row) => start + Number(row.k)));
    // Progressive persistence: each batch's findings survive even if a later
    // batch fails or the job is killed.
    await transaction(store, scope, async (tx) => {
      const current = await tx.get(job.id);
      if (!current || current.data.status === "canceled") return;
      const w = (await tx.get("workspace"))!;
      const currentSuggestion = w.data?.onboarding?.ontologySuggestion;
      if (
        !currentSuggestion ||
        currentSuggestion.hash !== (suggestion as any).hash
      )
        return;
      const have = new Set(
        ((currentSuggestion.notes as any[]) || []).map((n) => n.text),
      );
      const notes = [...((currentSuggestion.notes as any[]) || [])];
      slice.forEach((_, k) => {
        const i = start + k;
        if (seen.has(i)) return;
        const text = noteFor(curated[i]);
        if (have.has(text)) return;
        have.add(text);
        notes.push({
          kind: "unmatched",
          text,
          entities: [curated[i].from, curated[i].to],
          links: [curated[i].id],
        });
        suspect++;
      });
      tx.update(w, {
        ...w.data,
        onboarding: {
          ...(w.data.onboarding || {}),
          ontologySuggestion: { ...currentSuggestion, notes },
        },
      });
      if (current.data.status !== "canceled")
        tx.update(current, {
          ...current.data,
          progress: {
            stage: "validating",
            message: `Checking catalog links ${Math.min(start + BATCH, branches.length)} of ${branches.length}`,
            at: Date.now(),
          },
        });
    });
  }
  return { checked: curated.length, suspect };
}
