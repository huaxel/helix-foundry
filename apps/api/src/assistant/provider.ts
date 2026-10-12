import {
  type Bundle,
  ProviderSchema,
  type Resource,
  type ValidationReport,
  datasetAliases,
  datasetTable,
} from "../../../../packages/shared/src/index.js";
import type { Store } from "../store.js";
import { assert, digest, unseal } from "../security.js";
import { config } from "../config.js";

export const proposalHash = (bundle: Bundle, report: ValidationReport) =>
  digest(
    JSON.stringify({
      bundle,
      inputVersions: report.inputVersions,
      baseGeneration: report.baseGeneration || null,
    }),
  );
export async function providerSettings(store: Store, scope: string) {
  const r = await store.get(scope, "provider");
  return r
    ? {
        ...ProviderSchema.parse(r.data.settings),
        apiKey: r.data.secret ? unseal<string>(r.data.secret) : undefined,
      }
    : ProviderSchema.parse({
        provider: "local",
        localApi: "openai-compatible",
        model: "Qwen3.6-35B-A3B-MTP",
        baseUrl: config.modelEndpoint,
      });
}
export async function datasetsMap(store: Store, scope: string) {
  const generation = (await store.get(scope, "workspace"))?.data
    .activeGeneration;
  return new Map(
    (await store.list(scope, "dataset"))
      .filter((d) => !d.data.generation || d.data.generation === generation)
      .map((d) => [d.id, d]),
  );
}
export async function inputsFor(
  store: Store,
  scope: string,
  ids: string[],
  datasets: Map<string, Resource>,
) {
  // Local Parquet datasets are file references, not snapshots: forward the
  // version's source path so the executor reads the mounted file instead of
  // a snapshot that was never materialized. Derived-only inputs have no
  // version record and keep resolving to their persisted snapshot.
  return Promise.all(
    [...new Set(ids)].map(async (id) => {
      const d = datasets.get(id);
      assert(d?.data.activeVersion, `Unknown dataset ${id}`);
      const v = await store.get(scope, d.data.activeVersion as string);
      return {
        table: datasetTable(id),
        version: d.data.activeVersion as string,
        ...(v?.data?.sourcePath
          ? {
              sourcePath: v.data.sourcePath,
              sourceFingerprint: v.data.sourceFingerprint,
            }
          : {}),
        aliases: datasetAliases(d.name),
      };
    }),
  );
}
