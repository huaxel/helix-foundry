import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore } from "../apps/api/src/store.js";
// Immutable caching for hashed web assets; index.html stays fresh so upgrades
// apply. Skipped when apps/web/dist was never built (CI runs tests pre-build).
const dist = "apps/web/dist";
const asset = existsSync(dist + "/assets")
  ? readdirSync(dist + "/assets").find((f) => f.endsWith(".js"))
  : undefined;
describe.runIf(!!asset)("static asset caching", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    app = await createApp(new MemoryStore());
    await app.ready();
  });
  afterAll(() => app.close());
  it("caches hashed /assets/ immutable for a year", async () => {
    const r = await app.inject({ method: "GET", url: `/assets/${asset}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });
  it("does not long-cache the app shell", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"] || "").not.toContain("immutable");
  });
});
