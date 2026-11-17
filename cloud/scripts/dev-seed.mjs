// Fills a local dev console (npm run dev, wrangler dev --local) with a small test library,
// playlists, groups, projectors, schedule rules and two more users, all through the same HTTP
// routes the browser uses. Local throwaway data only: never point it at the live site.
//
//   node scripts/dev-seed.mjs [base]        (base defaults to http://127.0.0.1:8787)
//
// Needs ffmpeg and ffprobe on the PATH (the test pictures and clips are generated, a few MB in
// all, into the system temp folder). On an empty database it creates the first admin with the
// e2e fixtures' sign-in (e2e/e2e_common.py) and the dev script's setup token (package.json);
// run again it signs in and skips what is already there.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const MEDIA = path.join(os.tmpdir(), "p5k-dev-seed");
mkdirSync(MEDIA, { recursive: true });

export const ADMIN = { username: "admin", password: "test1234" }; // e2e/e2e_common.py setup_admin
const SETUP_TOKEN = "dev-setup-token";                              // package.json "dev"

// ---------------------------------------------------------------- http ---
const jar = new Map();
function keep(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    if (/max-age=0/i.test(c) || value === "") jar.delete(name); else jar.set(name, value);
  }
  return res;
}
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function get(p, headers = {}) {
  return keep(await fetch(BASE + p, { redirect: "manual", headers: { cookie: cookie(), accept: "text/html", ...headers } }));
}
let csrfToken = null;
async function csrf(p = "/library") {
  const html = await (await get(p)).text();
  const m = /<meta name="csrf-token" content="([^"]+)">/.exec(html);
  if (!m) throw new Error("no csrf on " + p + ": " + html.slice(0, 200));
  csrfToken = m[1];
  return csrfToken;
}
async function post(p, data) {
  const body = new URLSearchParams({ ...data, csrf_token: csrfToken });
  const res = keep(await fetch(BASE + p, { method: "POST", redirect: "manual", body,
    headers: { cookie: cookie(), accept: "text/html", "content-type": "application/x-www-form-urlencoded" } }));
  if (res.status >= 400) throw new Error(`POST ${p} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}
async function postJson(p, payload) {
  const res = keep(await fetch(BASE + p, { method: "POST", redirect: "manual", body: JSON.stringify(payload),
    headers: { cookie: cookie(), "content-type": "application/json", "x-csrf-token": csrfToken } }));
  const text = await res.text();
  if (res.status >= 400) throw new Error(`POST ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// --------------------------------------------------------------- media ---
const ff = (args, stderr = "inherit") => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", stderr] });
// The clips are encoded on the GPU (NVENC) where the machine has one; where it has none,
// makeMedia swaps in ffmpeg's CPU encoders.
const CPU = { h264_nvenc: "libx264", av1_nvenc: "libvpx-vp9" };
const H264 = ["-c:v", "h264_nvenc", "-pix_fmt", "yuv420p"];
// Landscape, upright and phone-sized pictures, an animated GIF, a long name, a clip that fades in
// from black (the preview must skip the black), and containers a browser may not play (mkv).
const FILES = [
  ["sunset-over-venue.jpg", ["-f", "lavfi", "-i", "gradients=size=1920x1080:c0=0xff7a18:c1=0x4a1d96:c2=0x0b1026:nb_colors=3:x0=0:y0=0:x1=1920:y1=1080", "-frames:v", "1", "-q:v", "3"]],
  ["IMG_4032.jpg", ["-f", "lavfi", "-i", "mandelbrot=size=4032x3024:start_scale=1.4", "-frames:v", "1", "-q:v", "4"]],
  ["poster-friday-night.png", ["-f", "lavfi", "-i", "testsrc2=size=1080x1920", "-frames:v", "1"]],
  ["logo-white-on-black.webp", ["-f", "lavfi", "-i", "rgbtestsrc=size=800x800", "-frames:v", "1"]],
  ["old-scan.bmp", ["-f", "lavfi", "-i", "smptebars=size=640x480", "-frames:v", "1"]],
  ["countdown.gif", ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=3"]],
  ["lobby-loop-1080p.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=6", ...H264, "-movflags", "+faststart"]],
  ["IMG_7781.MOV", ["-f", "lavfi", "-i", "life=size=1080x1920:rate=30:mold=10:ratio=0.1:death_color=0x1a0a3a:life_color=0xffffff", "-t", "5", ...H264]],
  ["Wedding Reception - Final Cut (v3) [approved by client] 2026-10-31.mp4", ["-f", "lavfi", "-i", "smptehdbars=size=1920x1080:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", ...H264, "-c:a", "aac", "-shortest", "-movflags", "+faststart"]],
  ["title-fade-in.mp4", ["-f", "lavfi", "-i", "mandelbrot=size=1280x720:rate=30", "-t", "6", "-vf", "fade=in:0:75", ...H264, "-movflags", "+faststart"]],
  ["ambient-plasma.webm", ["-f", "lavfi", "-i", "cellauto=size=1280x720:rate=30", "-t", "5", "-c:v", "av1_nvenc", "-b:v", "900k", "-pix_fmt", "yuv420p"]],
  ["archive-reel.mkv", ["-f", "lavfi", "-i", "yuvtestsrc=size=1280x720:rate=30:duration=4", ...H264]],
];
function makeMedia() {
  for (const [name, args] of FILES) {
    const out = path.join(MEDIA, name);
    if (existsSync(out)) continue;
    try { ff([...args, out], "ignore"); } catch { ff([...args.map((a) => CPU[a] || a), out]); }
  }
  const shot = path.join(MEDIA, "_screenshot.jpg");
  if (!existsSync(shot)) ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1", "-q:v", "5", shot]);
  const shot2 = path.join(MEDIA, "_screenshot2.jpg");
  if (!existsSync(shot2)) ff(["-f", "lavfi", "-i", "smptehdbars=size=1280x720", "-frames:v", "1", "-q:v", "5", shot2]);
}
function probe(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]).toString();
  const j = JSON.parse(out);
  const s = j.streams[0] || {};
  return { width: s.width || null, height: s.height || null, duration: j.format && j.format.duration ? Number(j.format.duration) : null };
}
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);
// init -> parts -> complete, as public/upload.js drives src/uploads.js
async function upload(name) {
  const file = path.join(MEDIA, name);
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ext = path.extname(name).toLowerCase();
  const isVideo = VIDEO_EXT.has(ext);
  const meta = probe(file);
  const body = { name, size: statSync(file).size, sha256, media_type: isVideo ? "video" : "image",
    duration_seconds: isVideo ? meta.duration : null, width: meta.width, height: meta.height };
  if (ext === ".gif") body.animated = true;
  let init;
  try {
    init = await postJson("/library/upload/init", body);
  } catch (e) {
    if (/409/.test(e.message)) { console.log("  already there:", name); return; }
    throw e;
  }
  const part = init.part_size;
  for (let n = 1, off = 0; off < bytes.length; n++, off += part) {
    const chunk = bytes.subarray(off, Math.min(off + part, bytes.length));
    const res = await fetch(`${BASE}/library/upload/${init.upload_id}/part/${n}`, { method: "PUT", body: chunk,
      headers: { cookie: cookie(), "x-csrf-token": csrfToken, "content-type": "application/octet-stream" } });
    if (!res.ok) throw new Error(`part ${n} of ${name}: ${res.status} ${await res.text()}`);
  }
  const done = await postJson(`/library/upload/${init.upload_id}/complete`, {});
  console.log("  uploaded", name, "->", done.media_id);
  return done.media_id;
}

// ---------------------------------------------------------------- seed ---
async function main() {
  makeMedia();
  // first admin (or sign in when the database already has one)
  const first = await get("/setup?token=" + SETUP_TOKEN);
  if (first.status === 200) {
    const html = await first.text();
    csrfToken = /<meta name="csrf-token" content="([^"]+)">/.exec(html)[1];
    await post("/setup", { token: SETUP_TOKEN, username: ADMIN.username, password: ADMIN.password, password2: ADMIN.password });
    console.log("admin created");
  } else {
    await csrf("/login");
    await post("/login", ADMIN);
    console.log("signed in");
  }
  await csrf("/library");

  console.log("library:");
  const ids = {};
  for (const [name] of FILES) ids[name] = await upload(name);

  // playlists (on an empty database "Lobby loop" gets id 2: id 1 is the account's Default)
  const newPlaylist = async (name) => {
    try {
      const res = await post("/playlists", { name });
      return Number(res.headers.get("location").split("/").pop());
    } catch (e) { if (/409/.test(e.message)) return null; throw e; }
  };
  const lobby = await newPlaylist("Lobby loop");
  const friday = await newPlaylist("Friday night");
  await newPlaylist("Empty for now");
  const add = async (pid, name) => { if (pid && ids[name]) await post(`/playlists/${pid}/items`, { media_id: ids[name] }); };
  for (const n of ["lobby-loop-1080p.mp4", "sunset-over-venue.jpg", "logo-white-on-black.webp"]) await add(lobby, n);
  for (const n of ["poster-friday-night.png", "IMG_7781.MOV", "title-fade-in.mp4", "countdown.gif"]) await add(friday, n);
  console.log("playlists:", lobby, friday);

  // groups
  for (const name of ["Lobby projectors", "Stage"]) {
    try { await post("/groups", { name }); } catch (e) { if (!/409/.test(e.message)) throw e; }
  }

  // projectors: one playing with a screenshot and a camera picture, one playing slowly on the
  // CPU, one whose player is down with a sync problem, one that never checked in
  const DEVICES = [["lobby-projector", "Lobby Projector"], ["stage-left", "Stage Left"], ["stage-right", "Stage Right"], ["back-room", "Back Room (spare)"]];
  for (const [device_id, name] of DEVICES) {
    try { await post("/devices", { device_id, name }); } catch (e) { if (!/409/.test(e.message)) throw e; }
  }
  const page = await (await get("/devices")).text();
  const dev = {};
  for (const r of page.split('<div class="device-row').slice(1)) {
    const id = /action="\/devices\/(\d+)\/rename"/.exec(r);
    const m = /DEVICE_ID=([a-z0-9-]+) \\\s*\nDEVICE_TOKEN=(\S+)/.exec(r);
    if (id && m) dev[m[1]] = { id: Number(id[1]), token: m[2] };
  }
  console.log("devices:", Object.keys(dev).join(", "));
  const sync = async (deviceId, q) => {
    const res = await fetch(`${BASE}/api/sync/${deviceId}?${new URLSearchParams(q)}`, { headers: { authorization: "Bearer " + dev[deviceId].token } });
    if (!res.ok) throw new Error(`sync ${deviceId}: ${res.status} ${await res.text()}`);
  };
  const shot = async (deviceId, file, route = "screenshots") => {
    const fd = new FormData();
    fd.append("file", new Blob([readFileSync(path.join(MEDIA, file))], { type: "image/jpeg" }), "shot.jpg");
    const res = await fetch(`${BASE}/api/${route}/${deviceId}`, { method: "POST", body: fd, headers: { authorization: "Bearer " + dev[deviceId].token } });
    if (!res.ok) throw new Error(`${route} ${deviceId}: ${res.status} ${await res.text()}`);
  };
  if (dev["lobby-projector"]) {
    await sync("lobby-projector", { player_status: "playing", current_position: "0", current_filename: "lobby-loop-1080p.mp4", player_version: "0.7.9", pi_model: "Raspberry Pi 5 Model B Rev 1.0", camera_supported: "1", decode_mode: "v4l2m2m-copy", play_rate: "1.0", display_fps: "60", video_fps: "30", drop_rate: "0.0" });
    await shot("lobby-projector", "_screenshot.jpg");
    await shot("lobby-projector", "_screenshot2.jpg", "camera");
  }
  if (dev["stage-left"]) {
    await sync("stage-left", { player_status: "playing", current_position: "1", current_filename: "IMG_7781.MOV", player_version: "0.7.9", pi_model: "Raspberry Pi 4 Model B Rev 1.5", camera_supported: "1", decode_mode: "software", play_rate: "0.62", display_fps: "60", video_fps: "30", drop_rate: "212" });
    await shot("stage-left", "_screenshot2.jpg");
  }
  if (dev["stage-right"]) {
    await sync("stage-right", { player_status: "mpv-down", player_version: "0.7.6", pi_model: "Raspberry Pi Zero 2 W Rev 1.0", camera_supported: "0", sync_error: "download failed: lobby-loop-1080p.mp4 (connection reset by peer)" });
  }

  // what plays where
  if (dev["lobby-projector"] && lobby) await post(`/devices/${dev["lobby-projector"].id}/assign`, { playlist_id: lobby });
  if (dev["stage-left"] && friday) {
    await post(`/devices/${dev["stage-left"].id}/schedule`, { name: "Friday night show", playlist_id: friday, priority: "10", start_time: "18:00", end_time: "23:30", days_of_week: "4", start_date: "", end_date: "" });
    await post(`/devices/${dev["stage-left"].id}/schedule`, { name: "Always on", playlist_id: lobby || friday, priority: "1", start_time: "", end_time: "", days_of_week: "", start_date: "", end_date: "" });
  }
  if (dev["back-room"]) await post(`/devices/${dev["back-room"].id}/command`, { command: "force-sync" }).catch((e) => console.log("  command:", e.message.slice(0, 120)));

  // an editor and a viewer, to look at the pages as each role
  for (const [username, role] of [["sam-editor", "editor"], ["vee-viewer", "viewer"]]) {
    try { await post("/users", { username, password: ADMIN.password, role }); } catch (e) { console.log("  user", username, e.message.slice(0, 100)); }
  }
  console.log("done");
}

main().catch((e) => { console.error(e); process.exit(1); });
