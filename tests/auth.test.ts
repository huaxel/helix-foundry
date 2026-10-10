import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { config, requireSecrets } from "../apps/api/src/config.js";
import { digest } from "../apps/api/src/security.js";

const TEST_PASSWORD = "test-password-12345678";
const previousAuthPassword = config.authPassword;
const previousRequireAuth = config.requireAuth;
const previousEncryptionKey = config.encryptionKey;
const previousInternalKey = config.internalKey;
const previousOrigin = config.origin;

let app: Awaited<ReturnType<typeof createApp>>;
let store: MemoryStore;

beforeAll(async () => {
  config.authPassword = TEST_PASSWORD;
  config.requireAuth = true;
  store = new MemoryStore();
  app = await createApp(store);
  await app.ready();
});
afterAll(async () => {
  config.authPassword = previousAuthPassword;
  config.requireAuth = previousRequireAuth;
  config.encryptionKey = previousEncryptionKey;
  config.internalKey = previousInternalKey;
  config.origin = previousOrigin;
  await app.close();
});

const login = (password: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password },
  });
const sessionCookie = (res: any) => {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(raw || "").split(";")[0];
};

it("rejects unauthenticated API access when auth is required", async () => {
  const me = await app.inject({ method: "GET", url: "/api/v1/me" });
  expect(me.statusCode).toBe(401);
});

it("keeps health public", async () => {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  expect(health.statusCode).toBe(200);
  expect(health.json()).toMatchObject({ ok: true });
});

it("rejects wrong passwords and accepts the configured one", async () => {
  expect((await login("wrong-password")).statusCode).toBe(401);
  const good = await login(TEST_PASSWORD);
  expect(good.statusCode).toBe(200);
  expect(sessionCookie(good)).toMatch(/^foundry_session=[A-Za-z0-9_-]+$/);
});

it("serves authenticated requests via session cookie", async () => {
  const cookie = sessionCookie(await login(TEST_PASSWORD));
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie },
  });
  expect(me.statusCode).toBe(200);
  expect(me.json().workspaces).toHaveLength(1);
});

it("never accepts the predictable local-session id via cookie", async () => {
  const forged = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: "foundry_session=local-session" },
  });
  expect(forged.statusCode).toBe(401);
});

it("revokes sessions on logout", async () => {
  const cookie = sessionCookie(await login(TEST_PASSWORD));
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(200);
  const out = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie },
  });
  expect(out.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(401);
});

it("still honors workspace Bearer tokens without cookies", async () => {
  const cookie = sessionCookie(await login(TEST_PASSWORD));
  const scope = (
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })
  ).json().workspaces[0].id;
  const userId = (
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })
  ).json().user.id;
  const tokenValue = "test-token-" + randomUUID();
  await transaction(store, "global", async (tx) => {
    tx.put(
      resource("global", "token", "Test token", { userId }, digest(tokenValue)),
    );
  });
  const viaToken = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: "Bearer " + tokenValue },
  });
  expect(viaToken.statusCode).toBe(200);
  expect(viaToken.json().workspaces[0].id).toBe(scope);
});

it("refuses non-loopback origins without a password", () => {
  config.encryptionKey = "x".repeat(32);
  config.internalKey = "x".repeat(32);
  try {
    config.origin = "http://100.81.226.52:3001";
    config.authPassword = "";
    config.requireAuth = false;
    expect(() => requireSecrets()).toThrow(/AUTH_PASSWORD/);
    config.authPassword = TEST_PASSWORD;
    config.requireAuth = true;
    expect(() => requireSecrets()).not.toThrow();
  } finally {
    config.origin = previousOrigin;
    config.authPassword = TEST_PASSWORD;
    config.requireAuth = true;
  }
});

it("refuses weak passwords at boot", () => {
  config.encryptionKey = "x".repeat(32);
  config.internalKey = "x".repeat(32);
  try {
    config.authPassword = "short";
    expect(() => requireSecrets()).toThrow(/at least 8/);
  } finally {
    config.authPassword = TEST_PASSWORD;
  }
});
