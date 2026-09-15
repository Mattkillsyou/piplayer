import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Setup files run outside the per-test-file storage isolation and may run several times;
// applyD1Migrations only applies what is missing, so this is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
