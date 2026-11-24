// The library track's fixes to the Library and a file's own page (src/pages/library.js) and to
// the notice a redirect carries (src/auth.js flashRedirect).
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { media, post, roles } from "./pages_common.js";

let r;

// [kind, message] of the notice the next page shows (and clears).
const flash = async (c, path = "/library") => /<div class="alert ([a-z]+)" role="alert">([^<]*)<\/div>/.exec(await (await c.get(path)).text())?.slice(1);

beforeAll(async () => {
  r = await roles();
});

describe("a notice too long for its cookie", () => {
  it("is cut to 300 characters, so a long non-ASCII name still gets its notice", async () => {
    const m = await media("short.jpg");
    for (const [name, kept] of [["日".repeat(1020) + ".jpg", "日".repeat(289)], ["😀".repeat(510) + ".jpg", "😀".repeat(289)]]) {
      const res = await post(r.editor, `/library/${m}/rename`, { name });
      expect(res.status).toBe(303);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("piplayer_flash="));
      // a browser drops a cookie whose name and value pass 4096 bytes
      expect(new TextEncoder().encode(cookie.split(";")[0]).length).toBeLessThanOrEqual(4096);
      expect(await flash(r.editor, `/library/${m}`)).toEqual(["ok", `Renamed to ${kept}…`]);
      expect((await query("SELECT original_name FROM media WHERE id = ?", m))[0].original_name).toBe(name);
    }
  });
});
