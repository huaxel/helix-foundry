import { describe, expect, it } from "vitest";
import { resource } from "../apps/api/src/store.js";
import { inputsFor } from "../apps/api/src/assistant.js";
import {
  applyPartitionPrune,
  prunePartitionInputs,
} from "../apps/api/src/assistant/provider.js";
import { datasetTable } from "../packages/shared/src/index.js";

const scope = "test";

function dataset(id: string, version: string) {
  return resource(
    scope,
    "dataset",
    "BUT000",
    { activeVersion: version, profile: { columns: [] } },
    id,
  );
}

describe("build inputs for local datasets", () => {
  it("forwards the mounted source path so the executor reads the file", async () => {
    const store = {
      get: async (_s: string, id: string) =>
        id === "v1"
          ? resource(scope, "version", "v1", {
              sourcePath: "zbp/BUT000.parquet",
              sourceFingerprint: { size: 10, mtimeMs: 20 },
            })
          : undefined,
    };
    const inputs = await inputsFor(
      store as any,
      scope,
      ["d1"],
      new Map([[dataset("d1", "v1").id, dataset("d1", "v1")]]),
    );
    expect(inputs[0].sourcePath).toBe("zbp/BUT000.parquet");
    expect(inputs[0].sourceFingerprint).toEqual({ size: 10, mtimeMs: 20 });
  });

  it("keeps snapshot resolution for derived inputs without a version record", async () => {
    const store = { get: async () => undefined };
    const inputs = await inputsFor(
      store as any,
      scope,
      ["p1"],
      new Map([[dataset("p1", "pipeline_abc").id, dataset("p1", "pipeline_abc")]]),
    );
    expect(inputs[0].version).toBe("pipeline_abc");
    expect("sourcePath" in inputs[0]).toBe(false);
  });
});

describe("partition pruning", () => {
  const manifest = [
    { key: "EU", file: "partitions/EU.parquet", rows: 2, size: 1 },
    { key: "US", file: "partitions/US.parquet", rows: 1, size: 1 },
    { key: "AP", file: "partitions/AP.parquet", rows: 1, size: 1 },
  ];
  const files = manifest.map((m) => m.file);
  const d1 = dataset("d1", "v1");
  const table = datasetTable(d1.id);

  it("keeps every partition when nothing is declared", () => {
    const inputs = [{ table, files }];
    expect(prunePartitionInputs(inputs, undefined, {})).toBe(inputs);
    expect(prunePartitionInputs(inputs, {}, {})).toBe(inputs);
  });

  it("prunes to the declared partition files", () => {
    const inputs = [{ table, files }];
    const r = prunePartitionInputs(inputs, { [table]: ["US"] }, { [table]: manifest });
    expect(r[0].files).toEqual(["partitions/US.parquet"]);
  });

  it("keeps every partition when the declared values match none", () => {
    const inputs = [{ table, files }];
    const r = prunePartitionInputs(inputs, { [table]: ["ZZ"] }, { [table]: manifest });
    expect(r[0].files).toEqual(files);
  });

  it("resolves the declaration by dataset id and fetches the manifest", async () => {
    const store = {
      get: async (_s: string, id: string) =>
        id === "v1"
          ? resource(scope, "version", "v1", {
              partitions: manifest,
              partitionColumn: "region",
            })
          : undefined,
    };
    const inputs = [{ table, version: "v1", files, aliases: [] }];
    const map = new Map([[d1.id, d1]]);
    const r = await applyPartitionPrune(
      inputs,
      { [d1.id]: ["AP"] },
      map,
      store as any,
      scope,
    );
    expect(r[0].files).toEqual(["partitions/AP.parquet"]);
  });

  it("leaves non-partitioned inputs untouched", async () => {
    const inputs = [{ table, version: "v1", files: ["v1.parquet"] }];
    const store = {
      get: async () => resource(scope, "version", "v1", { file: "v1.parquet" }),
    };
    const map = new Map([[d1.id, d1]]);
    const r = await applyPartitionPrune(
      inputs,
      { [table]: ["EU"] },
      map,
      store as any,
      scope,
    );
    expect(r[0].files).toEqual(["v1.parquet"]);
  });
});
