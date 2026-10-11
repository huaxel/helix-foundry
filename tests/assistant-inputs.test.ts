import { describe, expect, it } from "vitest";
import { resource } from "../apps/api/src/store.js";
import { inputsFor } from "../apps/api/src/assistant.js";

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
