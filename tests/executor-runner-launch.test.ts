import { expect, it } from "vitest";
import { runnerLaunch, shellQuote } from "../services/executor/src/runner-launch.js";

it("loads the runner with plain node when it is compiled JavaScript", () => {
  const launch = runnerLaunch("/app/dist/services/executor/src/runner.js", true);
  expect(launch.args).toEqual(["/app/dist/services/executor/src/runner.js"]);
  expect(launch.args).not.toContain("--import");
  expect(launch.shell).toBe(
    "exec node '/app/dist/services/executor/src/runner.js'",
  );
});

it("keeps the TypeScript loader when running from source", () => {
  const launch = runnerLaunch("/repo/services/executor/src/runner.js", false);
  expect(launch.args).toEqual([
    "--import",
    "tsx",
    "/repo/services/executor/src/runner.js",
  ]);
  expect(launch.shell).toBe(
    "exec node --import tsx '/repo/services/executor/src/runner.js'",
  );
});

it("quotes paths so the sandbox shell cannot break out", () => {
  expect(shellQuote("/a b/c'd.js")).toBe("'/a b/c'\\''d.js'");
  const launch = runnerLaunch("/a b/c'd.js", true);
  expect(launch.shell).toBe("exec node '/a b/c'\\''d.js'");
});