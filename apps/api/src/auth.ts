import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { resource, transaction, type Store } from "./store.js";

const scrypt = promisify(scryptCb);
export const SESSION_COOKIE = "foundry_session";
// Browser sessions last 30 days; API tokens carry their own expiry.
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600;

// In-memory verifier derived from AUTH_PASSWORD at boot. Nothing password-
// equivalent is persisted; a restart re-derives it from the configured value.
let verifier: { salt: Buffer; hash: Buffer } | undefined;
async function getVerifier() {
  if (!verifier && config.authPassword) {
    const salt = randomBytes(16);
    verifier = {
      salt,
      hash: (await scrypt(config.authPassword, salt, 64)) as Buffer,
    };
  }
  return verifier;
}
export async function verifyPassword(input: string): Promise<boolean> {
  const v = await getVerifier();
  if (!v || !input) return false;
  const hash = (await scrypt(input, v.salt, 64)) as Buffer;
  return (
    hash.length === v.hash.length && timingSafeEqual(hash, v.hash)
  );
}
// Password sessions are unpredictable, marked, and expiring. The predictable
// local-session id is never issued here and never accepted via cookie.
export async function createPasswordSession(store: Store, userId: string) {
  const session = resource("global", "session", "Password session", {
    userId,
    viaPassword: true,
    expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  });
  await transaction(store, "global", async (tx) => {
    tx.put(session);
  });
  return session;
}
export async function revokePasswordSession(store: Store, sessionId: string) {
  await transaction(store, "global", async (tx) => {
    const s = await tx.get(sessionId);
    if (s?.kind === "session" && s.data.viaPassword) tx.delete(sessionId);
  });
}
export function isSessionCookieId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value)
  );
}
