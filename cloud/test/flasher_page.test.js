// /flasher: the SD flasher downloads and steps behind sign-in, the nav item, the home page
// without them, and the old /download address.
import { beforeAll, describe, expect, it } from "vitest";
import { FLASHER_VERSION } from "../src/pages/flasher.js";
import { Client } from "./helpers.js";
import { roles } from "./pages_common.js";

const RELEASE = `https://github.com/Mattkillsyou/piplayer/releases/download/v${FLASHER_VERSION}`;
const FILES = ["Projection5000-SD-Flasher.exe", "Projection5000-SD-Flasher-mac-arm64.dmg", "Projection5000-SD-Flasher-mac-intel.dmg"];

let r;

beforeAll(async () => {
  r = await roles();
});

describe("/flasher", () => {
  it("every signed-in role gets the three v0.7.0 links and the steps", async () => {
    expect(FLASHER_VERSION).toBe("0.7.0");
    for (const role of ["viewer", "editor", "admin"]) {
      const res = await r[role].get("/flasher");
      expect(res.status, role).toBe(200);
      const html = await res.text();
      expect(html).toContain("<h1>SD Flasher</h1>");
      for (const f of FILES) expect(html, `${role} ${f}`).toContain(`href="${RELEASE}/${f}"`);
      expect(html).toContain("sign in to it with the same username and password as here.");
      expect(html).toContain("Which Mac do I have?");
      expect(html).toContain("First time on this computer");
      expect(html).toContain("Then, every time");
      expect(html).toContain("The first time, the flasher asks for your console username and password.");
      expect(html).toContain("in the account that flashed it.");
      expect(html).not.toContain("a browser page opens");
    }
  });

  it("anonymous -> 303 /login", async () => {
    const res = await new Client().get("/flasher");
    expect([res.status, res.headers.get("location")]).toEqual([303, "/login"]);
  });

  it("the nav has SD Flasher on every page, for every role", async () => {
    for (const role of ["viewer", "editor", "admin"]) {
      for (const p of ["/dashboard", "/devices", "/flasher"]) {
        const html = await (await r[role].get(p)).text();
        expect(html, `${role} ${p}`).toContain(`<a href="/flasher"${p === "/flasher" ? ' class="active"' : ""}>SD Flasher</a>`);
      }
    }
  });
});

describe("home page and /download", () => {
  it("/ has the two buttons and no download links", async () => {
    const res = await new Client().get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a class="btn" href="/login">Sign in</a>');
    expect(html).toContain('<a class="btn secondary" href="/signup">Create an account</a>');
    expect(html).toContain("Sign in to download the SD Flasher and manage your projectors.");
    expect(html).not.toContain("releases/download/");
    expect(html).not.toContain("Then, every time");
    expect(html).toContain("<title>Projection5000</title>");
  });

  it("/download: signed in -> 303 /flasher, anonymous -> 301 /", async () => {
    for (const role of ["viewer", "editor", "admin"]) {
      const res = await r[role].get("/download");
      expect([res.status, res.headers.get("location")], role).toEqual([303, "/flasher"]);
    }
    const anon = await new Client().get("/download");
    expect([anon.status, anon.headers.get("location")]).toEqual([301, "/"]);
    const head = await new Client().fetch("/download", { method: "HEAD" });
    expect([head.status, head.headers.get("location")]).toEqual([301, "/"]);
  });
});
