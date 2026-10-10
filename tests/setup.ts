// Tests run with loopback-owner behavior (no password) unless a file opts
// into auth by setting config.authPassword/requireAuth directly (see
// auth.test.ts). Clearing here blocks dotenv from picking up a developer's
// local .env AUTH_PASSWORD, which would otherwise enable requireAuth
// globally and break the unauthenticated assumptions of other suites.
// dotenv never overwrites an already-set variable, so this sticks.
process.env.AUTH_PASSWORD = "";
