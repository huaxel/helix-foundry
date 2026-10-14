import { it, expect, vi, afterEach } from "vitest";
import { MeridianClient, MeridianError } from "../packages/sdk/src/index.js";
afterEach(() => vi.unstubAllGlobals());
// A fetch mock that honors abort like real fetch (rejects with TimeoutError),
// but never otherwise responds: exercises the client timeout path.
const hangingFetch = vi.fn(
  (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("signal timed out", "TimeoutError")),
      );
    }),
);
it("fails hung requests with MeridianError 408 instead of hanging forever", async () => {
  vi.stubGlobal("fetch", hangingFetch);
  const client = new MeridianClient({
    baseUrl: "https://foundry.invalid",
    workspaceId: "w",
    token: "fixture",
    timeoutMs: 100,
  });
  const start = Date.now();
  await expect(client.list("dataset")).rejects.toMatchObject({
    status: 408,
  } satisfies Partial<MeridianError>);
  expect(Date.now() - start).toBeLessThan(5000);
  expect(hangingFetch).toHaveBeenCalledOnce();
});
it("defaults to a 10-minute timeout covering long imports", async () => {
  const f = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", f);
  const client = new MeridianClient({
    baseUrl: "https://foundry.invalid",
    workspaceId: "w",
    token: "fixture",
  });
  await client.list("dataset");
  const signal = f.mock.calls[0][1].signal as AbortSignal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal.aborted).toBe(false);
});
