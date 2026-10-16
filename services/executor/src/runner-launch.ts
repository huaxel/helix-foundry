// How the per-job child process is launched.
//
// The child is spawned as `node [--import tsx] runner.js`. tsx is a TypeScript
// loader: from the source tree it is what makes the `.js` specifier resolve to
// `runner.ts`, but the packaged image ships compiled JavaScript, where loading
// it costs ~105ms per query (measured in the executor container: 289ms vs
// 183ms to import the engine) for nothing. So tsx is used only when the runner
// is NOT already compiled JavaScript, i.e. in development.
export type RunnerLaunch = { args: string[]; shell: string };

export function runnerLaunch(
  runnerPath: string,
  compiled: boolean,
): RunnerLaunch {
  const loader = compiled ? [] : ["--import", "tsx"];
  return {
    args: [...loader, runnerPath],
    // Same command as a shell line for the stream-mode sandbox, which runs it
    // inside `unshare -rm sh -c`.
    shell: `exec node ${loader.length ? loader.join(" ") + " " : ""}${shellQuote(runnerPath)}`,
  };
}

// Single-quote a value so it survives the sandbox's `sh -c`.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}