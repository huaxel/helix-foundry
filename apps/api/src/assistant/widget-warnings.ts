import type { ValidationReport } from "../../../../packages/shared/src/index.js";

export function assumptionsWithDroppedWidgets(
  assumptions: string[],
  report: ValidationReport,
): string[] {
  const failedWidgets = report.checks
    .filter((c) => !c.passed && c.name.startsWith("Dashboard: "))
    .map(
      (c) =>
        `${c.name.slice("Dashboard: ".length)} (${c.detail.slice(0, 200)})`,
    );
  if (!failedWidgets.length) return assumptions;

  const note = `${failedWidgets.length} dashboard widget${failedWidgets.length === 1 ? " was" : "s were"} omitted because validation failed: ${failedWidgets.join("; ")}.`;
  return assumptions.includes(note) ? assumptions : [...assumptions, note];
}
