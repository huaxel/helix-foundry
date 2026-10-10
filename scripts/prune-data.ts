import "dotenv/config";
import { rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { config } from "../apps/api/src/config.js";
import { store, transaction } from "../apps/api/src/store.js";

const KEEP_RECENT_VERSIONS = 2;
const apply = process.argv.includes("--apply");
const hasId = (value: unknown, ids: Set<string>): boolean => {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((entry) => hasId(entry, ids));
  if (value && typeof value === "object")
    return Object.values(value).some((entry) => hasId(entry, ids));
  return false;
};

async function main() {
  const workspaces = await store.list("global", "workspaceRef");
  let removedCount = 0;
  let removedBytes = 0;
  for (const workspace of workspaces) {
    const scope = workspace.id;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(scope)) continue;
    const rows = await store.list(scope);
    const datasets = rows.filter((r) => r.kind === "dataset");
    const versions = new Map(
      rows.filter((r) => r.kind === "version").map((r) => [r.id, r]),
    );
    for (const dataset of datasets) {
      const ids = Array.isArray(dataset.data.versions)
        ? dataset.data.versions.filter((id: unknown) => typeof id === "string")
        : [];
      const keep = new Set([
        ...ids.slice(0, KEEP_RECENT_VERSIONS),
        dataset.data.activeVersion,
        dataset.data.pendingVersion,
      ]);
      const candidates = ids.filter((id: string) => {
        const version = versions.get(id);
        return (
          !keep.has(id) &&
          version?.data.datasetId === dataset.id &&
          version.data.file === `${id}.parquet` &&
          !version.data.sourcePath
        );
      });
      if (!candidates.length) continue;

      const referenced = new Set<string>();
      const candidateSets = new Map(
        candidates.map((id: string) => [id, new Set([id])]),
      );
      const candidateIds = new Set(candidates);
      for (const resource of rows) {
        if (candidateIds.has(resource.id)) continue;
        const data = resource.data;
        // The owning dataset's version list is an index, not an external use.
        const scanData =
          resource.id === dataset.id
            ? Object.fromEntries(
                Object.entries(data).filter(([key]) => key !== "versions"),
              )
            : data;
        for (const id of candidates)
          if (hasId(scanData, candidateSets.get(id)!)) referenced.add(id);
      }
      const eligible = candidates.filter((id: string) => !referenced.has(id));
      for (const id of eligible) {
        const version = versions.get(id)!;
        const expectedFile = `${id}.parquet`;
        const file = version.data.file;
        let bytes = 0;
        if (file === expectedFile) {
          try {
            bytes = (
              await stat(resolve(config.dataDir, "datasets", scope, file))
            ).size;
          } catch {
            // Metadata can outlive a partially removed artifact.
          }
        }
        console.log(
          `${apply ? "remove" : "would remove"} workspace=${scope} dataset=${dataset.id} version=${id} bytes=${bytes}`,
        );
        if (!apply) {
          removedCount++;
          removedBytes += bytes;
          continue;
        }

        const removed = await transaction(store, scope, async (tx) => {
          const currentDataset = await tx.get(dataset.id);
          const currentVersion = await tx.get(id);
          if (
            !currentDataset ||
            currentVersion?.kind !== "version" ||
            currentVersion.data.datasetId !== currentDataset.id ||
            currentVersion.data.file !== expectedFile ||
            !currentDataset.data.versions?.includes(id) ||
            currentDataset.data.versions
              .slice(0, KEEP_RECENT_VERSIONS)
              .includes(id) ||
            currentDataset.data.activeVersion === id ||
            currentDataset.data.pendingVersion === id
          )
            return false;
          const currentRows = await tx.list();
          const stillReferenced = currentRows.some((resource) => {
            if (resource.id === id) return false;
            const data =
              resource.id === dataset.id
                ? Object.fromEntries(
                    Object.entries(resource.data).filter(
                      ([key]) => key !== "versions",
                    ),
                  )
                : resource.data;
            return hasId(data, new Set([id]));
          });
          if (stillReferenced) return false;
          tx.update(currentDataset, {
            ...currentDataset.data,
            versions: (currentDataset.data.versions || []).filter(
              (versionId: string) => versionId !== id,
            ),
          });
          tx.delete(id);
          return true;
        });
        if (!removed) continue;
        const filePath = resolve(
          config.dataDir,
          "datasets",
          scope,
          expectedFile,
        );
        if (basename(filePath) === expectedFile)
          await rm(filePath, { force: true });
        removedCount++;
        removedBytes += bytes;
      }
    }
  }
  console.log(
    `${apply ? "removed" : "dry run"}: ${removedCount} versions, ${(removedBytes / 1024 / 1024).toFixed(1)} MiB${apply ? "" : " (pass --apply to remove eligible files)"}`,
  );
}

await main();
