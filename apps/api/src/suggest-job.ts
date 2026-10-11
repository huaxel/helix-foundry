import type { Resource } from "../../../packages/shared/src/index.js";
import { suggestOntology } from "./discovery.js";
import { onboardingState } from "./onboarding-state.js";
import { jobProgress } from "./setup-jobs.js";
import { resource, transaction, type Store } from "./store.js";

// Background suggestion job: computes the ontology without blocking the setup
// POST, reporting real stages (reading/keys/matching/proposing) for the progress
// UI. Stores only if the data signature is still current; a stale run (the user
// changed the selection mid-run) succeeds without storing and the client queues
// a fresh one. Failures mark the job failed so the UI offers Retry.
export async function runSuggestJob(
  store: Store,
  scope: string,
  job: Resource,
): Promise<unknown> {
  const { onboardingSignature, datasetIds, sourceIds } = (job.data || {}) as {
    onboardingSignature?: string;
    datasetIds?: string[];
    sourceIds?: string[];
  };
  if (!onboardingSignature || !datasetIds?.length)
    throw new Error("Suggestion inputs changed. Retry the suggestion.");
  // Chunked loads: hundreds of simultaneous Helix reads overwhelm it.
  const chunked = async (ids: string[]) => {
    const out: Resource[] = [];
    for (let i = 0; i < ids.length; i += 50)
      out.push(
        ...(
          await Promise.all(ids.slice(i, i + 50).map((id) => store.get(scope, id)))
        ).filter((r) => !!r),
      );
    return out;
  };
  const [datasets, sources] = await Promise.all([
    chunked(datasetIds || []),
    chunked(sourceIds || []),
  ]);
  const valid = datasets.filter(
    (d) => d && d.data.activeVersion && d.data.profile?.columns,
  );
  if (!valid.length)
    throw new Error("Suggestion inputs changed. Retry the suggestion.");
  const report = (stage: string) =>
    void jobProgress(store, scope, job.id, {
      stage,
      message:
        stage === "reading"
          ? `Reading ${valid.length} tables`
          : stage === "keys"
            ? "Finding keys"
            : stage === "matching"
              ? "Matching records across sources"
              : "Proposing entities",
      at: Date.now(),
    }).catch(() => {});
  const suggestion = await suggestOntology(store, scope, {
    datasets: valid as Resource[],
    sources: sources.filter((s) => !!s) as Resource[],
    signature: onboardingSignature,
    onProgress: report,
  });
  await transaction(store, scope, async (tx) => {
    const current = await tx.get(job.id);
    if (!current || current.data.status === "canceled") return;
    const state = await onboardingState(
      { get: (_s, id) => tx.get(id), list: (_s, kind) => tx.list(kind) },
      scope,
    );
    if (state.signature !== onboardingSignature) return;
    const w = (await tx.get("workspace"))!;
    tx.update(w, {
      ...w.data,
      onboarding: {
        ...(w.data.onboarding || {}),
        ontologySuggestion: suggestion,
      },
    });
  });
  // Chain link validation for curated suggestions (advisory, background).
  const curatedCount = ((suggestion as any).links as any[]).filter((l) =>
    String(l.id || "").startsWith("catalog-"),
  ).length;
  if (curatedCount) {
    await transaction(store, scope, async (tx) => {
      const active = (await tx.list("job")).some(
        (j) =>
          j.data.type === "validate" &&
          j.data.onboardingSignature === onboardingSignature &&
          ["queued", "running"].includes(j.data.status),
      );
      if (!active)
        tx.put(
          resource(scope, "job", "Validate catalog links", {
            type: "validate",
            status: "queued",
            background: true,
            onboardingSignature,
            progress: { stage: "queued", message: "Queued validation" },
          }),
        );
    });
  }
  return suggestion;
}
