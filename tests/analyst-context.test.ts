import { describe, expect, it } from "vitest";
import { resource } from "../apps/api/src/store.js";
import { focusDatasets } from "../apps/api/src/assistant.js";
import {
  describeForMetrics,
  stratifyDatasets,
} from "../apps/api/src/metrics.js";

const scope = "focus";
const ds = (name: string, columns: string[], rows = 10) =>
  resource(
    scope,
    "dataset",
    name,
    {
      activeVersion: "v",
      profile: {
        rows,
        columns: columns.map((c) => ({ name: c, type: "VARCHAR" })),
        sample: [],
      },
    },
    name,
  );

describe("analyst focus", () => {
  const all = [
    ds("stg_div · ZST_SITVEHICLE", ["SITVEHICLE_ID", "PLATE_NR"], 27_000_000),
    ds("mobi · ZST_CALC_ATTR_LZ", ["SITVEHICLE_ID", "CALC"], 27_000_000),
    ds("FICA · DFKKOP", ["OPBEL", "GPART"], 47_000_000),
    ds("hr · small_table", ["DNI", "NOTE"], 300),
  ];
  it("ranks question-relevant tables first", () => {
    const top = focusDatasets(
      all,
      "Which zst sitvehicles have the most zst calc attr lzs?",
      2,
    ).map((d) => d.id);
    expect(top).toContain("stg_div · ZST_SITVEHICLE");
    expect(top).toContain("mobi · ZST_CALC_ATTR_LZ");
  });
  it("keeps published anchors even without token overlap", () => {
    const top = focusDatasets(all, "revenue totals", 2, ["hr · small_table"]);
    expect(top.map((d) => d.id)).toContain("hr · small_table");
  });
  it("falls back to size order without overlap", () => {
    const top = focusDatasets(all, "zzz qqq", 1);
    expect(top[0].id).toBe("FICA · DFKKOP");
  });
});

describe("stratification", () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    ds(`folder${i % 10} · table${i}`, ["id"], 1000 - i),
  );
  it("bounds the subset while covering every folder", () => {
    const sub = stratifyDatasets(many, 20);
    expect(sub.length).toBe(20);
    const folders = new Set(sub.map((d) => d.id.split(" · ")[0]));
    expect(folders.size).toBe(10);
  });
  it("bounds metric descriptions", () => {
    const described = describeForMetrics(many, 15);
    expect(described.length).toBe(15);
  });
});
