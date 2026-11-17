// Full-page screenshots of the local dev console, at a laptop's width and a phone's, for looking
// at every page after a change (and for before / after pairs). It also says which pages scroll
// sideways, which no page should.
//
//   npm i --no-save puppeteer-core          (once; it is not a dependency of the console)
//   node scripts/dev-shots.mjs [outDir] [page name | all] [desktop | phone | both] [user]
//
// Run scripts/dev-seed.mjs first: the playlist and schedule pages below are the ids it creates
// on an empty database, and the sign-in is its admin (or sam-editor / vee-viewer). Chrome is
// found in its usual place; set CHROME_PATH when it is somewhere else. Headless Chrome runs on
// the GPU (on Windows: --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist).
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.CONSOLE_URL || "http://127.0.0.1:8787";
const out = process.argv[2] || path.join(os.tmpdir(), "p5k-shots");
const filter = process.argv[3] && process.argv[3] !== "all" ? process.argv[3] : "";
const which = process.argv[4] || "both";
const user = process.argv[5] || "admin";
const PASSWORD = "test1234"; // every dev-seed user (e2e/e2e_common.py)
mkdirSync(out, { recursive: true });

const PAGES = [
  ["dashboard", "/dashboard"], ["library", "/library"], ["playlists", "/playlists"], ["playlist", "/playlists/2"],
  ["devices", "/devices"], ["schedule", "/devices/3/schedule"], ["groups", "/groups"], ["alerts", "/alerts"],
  ["audit", "/audit"], ["users", "/users"], ["settings", "/settings"], ["flasher", "/flasher"],
];
const VIEWS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const SLICE = { desktop: 1400, phone: 1500 }; // css px per image, so a long page stays readable

const CHROME = process.env.CHROME_PATH || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find(existsSync);
if (!CHROME) throw new Error("Chrome not found: set CHROME_PATH to its program file");
const GPU = process.platform === "win32"
  ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]
  : ["--enable-gpu", "--ignore-gpu-blocklist"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The Library's and the playlist editor's previews are made in the browser, one at a time, after
// the page has loaded, and a tile further down starts loading only near the screen: scroll the
// whole page, then wait until no tile is still loading or still being made.
async function previewsShown(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 400) { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(100); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => [...document.querySelectorAll(".media-thumb")].every((a) =>
    !a.classList.contains("is-making") && (a.querySelector("img").naturalWidth > 0 || a.classList.contains("no-preview"))),
  { timeout: 60000, polling: 250 }).catch(() => console.log("  !! previews still not all shown after 60 s"));
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [...GPU, "--hide-scrollbars"] });
try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.setViewport(VIEWS.desktop);
  await page.goto(BASE + "/login", { waitUntil: "networkidle2" });
  await page.type('input[name="username"]', user);
  await page.type('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }), page.click('button[type="submit"]')]);
  for (const [name, url] of PAGES) {
    if (filter && !name.includes(filter)) continue;
    for (const view of Object.keys(VIEWS)) {
      if (which !== "both" && which !== view) continue;
      await page.setViewport(VIEWS[view]);
      const res = await page.goto(BASE + url, { waitUntil: "networkidle2" });
      await previewsShown(page);
      await sleep(600);
      const dims = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      const n = Math.ceil(dims.h / SLICE[view]);
      for (let i = 0; i < n; i++) {
        const file = path.join(out, `${name}-${view}${n > 1 ? `-${i + 1}` : ""}.png`);
        await page.screenshot({ path: file, clip: { x: 0, y: i * SLICE[view], width: VIEWS[view].width, height: Math.min(SLICE[view], dims.h - i * SLICE[view]) }, captureBeyondViewport: true });
      }
      console.log(`${name} ${view}: ${res.status()} height ${dims.h}${dims.w > dims.cw ? `  !! page scrolls sideways (${dims.w} > ${dims.cw})` : ""} -> ${n} image(s)`);
    }
  }
  console.log("saved to " + out);
} finally {
  await browser.close();
}
