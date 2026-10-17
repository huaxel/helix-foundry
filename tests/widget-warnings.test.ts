import { describe, expect, it } from "vitest";
import { assumptionsWithDroppedWidgets } from "../apps/api/src/assistant/widget-warnings.js";
import type { ValidationReport } from "../packages/shared/src/index.js";

const report = (
  checks: ValidationReport["checks"],
): ValidationReport => ({
  valid: false,
  checks,
  previews: {},
  inputVersions: {},
  validatedAt: new Date().toISOString(),
  baseGeneration: null,
});

describe("dashboard widget omission warnings", () => {
  it("names failed widgets and explains why they were omitted", () => {
    expect(
      assumptionsWithDroppedWidgets(
        ["Existing assumption"],
        report([
          {
            name: "Dashboard: Overview / Revenue",
            passed: false,
            detail: "Column amount was not found",
          },
          { name: "Action: Update order", passed: false, detail: "Invalid" },
        ]),
      ),
    ).toEqual([
      "Existing assumption",
      "1 dashboard widget was omitted because validation failed: Overview / Revenue (Column amount was not found).",
    ]);
  });

  it("caps error details and does not append the same note twice", () => {
    const checks = [
      {
        name: "Dashboard: Overview / Revenue",
        passed: false,
        detail: "x".repeat(250),
      },
    ];
    const once = assumptionsWithDroppedWidgets([], report(checks));
    expect(once[0]).toHaveLength(200 + "1 dashboard widget was omitted because validation failed: Overview / Revenue ().".length);
    expect(assumptionsWithDroppedWidgets(once, report(checks))).toEqual(once);
  });

  it("leaves assumptions unchanged when no dashboard widget failed", () => {
    const assumptions = ["Existing assumption"];
    expect(
      assumptionsWithDroppedWidgets(
        assumptions,
        report([{ name: "Action: Update order", passed: false, detail: "Invalid" }]),
      ),
    ).toBe(assumptions);
  });
});
