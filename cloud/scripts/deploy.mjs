// npm run deploy: the pending migrations first, then the code, but only once none is left.
// Answering n at wrangler's "continue?" exits 0 with nothing applied; the new code on the old
// database then answered every request with a 500 until npm run migrate:remote ran.
import { execSync } from "node:child_process";

execSync("npm run migrate:remote", { stdio: "inherit" });
const left = execSync("npx wrangler d1 migrations list piplayer-cloud-db --remote", { encoding: "utf8" });
if (!left.includes("No migrations to apply")) {
  console.error(`${left}\nNot deployed: these migrations are not applied yet. Run npm run deploy again and answer y.`);
  process.exit(1);
}
execSync("npx wrangler deploy", { stdio: "inherit" });
