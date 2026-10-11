import type { Resource } from "../../../packages/shared/src/index.js";
import { CatalogSchema } from "../../../packages/shared/src/index.js";
import {
  indexCatalog,
  normTable,
  resolveColumn,
  unionTableColumns,
} from "./catalog-match.js";
import { transaction, type Store } from "./store.js";

// Advisory catalog audit (no executor): classifies every catalog join as
// applied or skipped (out-of-scope table, unresolvable key column,
// same-entity, duplicate) and records the headline in the suggestion summary.
// Per-link value coverage is NOT re-measured here — curated joins carry the
// upstream catalog's own golden measurements; Helix only verifies that each
// join resolves to real in-scope tables and columns (unresolvable joins are
// never emitted as links in the first place). Advisory only: never blocks,
// drops, or re-hashes the suggestion (the summary is outside the confirm hash).
export async function runValidateJob(
  store: Store,
  scope: string,
  job: Resource,
): Promise<unknown> {
  const { onboardingSignature } = (job.data || {}) as {
    onboardingSignature?: string;
  };
  if (!onboardingSignature) return null;
  const [workspace, catalogStored, datasets] = await Promise.all([
    store.get(scope, "workspace"),
    store.get(scope, "catalog"),
    store.list(scope, "dataset"),
  ]);
  const suggestion = workspace?.data?.onboarding?.ontologySuggestion;
  if (!suggestion || suggestion.signature !== onboardingSignature) return null;
  if (!catalogStored) return null;
  const parsed = CatalogSchema.safeParse(catalogStored.data);
  if (!parsed.success) return null;
  const catalog = parsed.data;
  if (!catalog.joins.length) return null;
  const unioned = unionTableColumns(datasets as any[]);
  const byTable = new Map<string, { columns: { name: string }[] }>();
  for (const [n, columns] of unioned) byTable.set(n, { columns });
  const appliedIds = new Set(
    ((suggestion.links as any[]) || [])
      .map((l) => l.id)
      .filter((id) => String(id).startsWith("catalog-")),
  );
  // Count hard skips with discovery's rules; the rest resolved, and whatever
  // resolved-but-unapplied was dropped as same-entity or duplicate.
  let outOfScope = 0,
    missingColumn = 0;
  for (const j of catalog.joins) {
    const a = byTable.get(normTable(j.leftTable)),
      b = byTable.get(normTable(j.rightTable));
    if (!a || !b) {
      outOfScope++;
      continue;
    }
    const aCol = resolveColumn(a.columns, j.leftKey),
      bCol = resolveColumn(b.columns, j.rightKey);
    if (!aCol || !bCol) missingColumn++;
  }
  const applied = appliedIds.size;
  const other = Math.max(
    0,
    catalog.joins.length - applied - outOfScope - missingColumn,
  );
  const skipped = outOfScope + missingColumn + other;
  const headline =
    ` Plus ${applied} of ${catalog.joins.length} catalog joins applied as links` +
    (skipped
      ? ` (${outOfScope} tables out of scope, ${missingColumn} unresolvable keys, ${other} same-entity or duplicate)`
      : "") +
    ".";
  let updated = false;
  await transaction(store, scope, async (tx) => {
    const current = await tx.get(job.id);
    if (!current || current.data.status === "canceled") return;
    const w = (await tx.get("workspace"))!;
    const currentSuggestion = w.data?.onboarding?.ontologySuggestion;
    if (
      !currentSuggestion ||
      currentSuggestion.hash !== (suggestion as any).hash ||
      currentSuggestion.signature !== onboardingSignature
    )
      return;
    if (!String(currentSuggestion.summary || "").includes(headline)) {
      tx.update(w, {
        ...w.data,
        onboarding: {
          ...(w.data.onboarding || {}),
          ontologySuggestion: {
            ...currentSuggestion,
            summary: `${currentSuggestion.summary || ""}${headline}`,
          },
        },
      });
      updated = true;
    }
  });
  return { applied, skipped, outOfScope, missingColumn, updated };
}
