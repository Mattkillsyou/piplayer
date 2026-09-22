// Runs the tests inside workerd with the bindings from wrangler.toml (local D1/R2 via
// Miniflare). Migrations are handed to the worker as a test-only binding and applied by
// test/apply-migrations.js (the pattern from workers-sdk fixtures/vitest-plugin-examples/d1).
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-session-secret",
            SETUP_TOKEN: "test-setup-token",
            // workerd here has no CPU budget: verify every test upload (production defaults to 8 MiB).
            PIPLAYER_VERIFY_SHA_MAX_BYTES: "5368709120",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.js"],
      setupFiles: ["./test/apply-migrations.js"],
      // The sequential sweeps (security.test.js) take 5-6 s in workerd; the 5 s default flakes.
      testTimeout: 30000,
    },
  };
});
