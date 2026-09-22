// Small helpers shared by every module: responses, escaping, the form/JSON validators
// ported from cms/app/routes/web.py, and time formatting in the site timezone.

export class HttpError extends Error {
  constructor(status, detail, headers) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

export function fail(status, detail) {
  throw new HttpError(status, detail);
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function redirect(location, status = 303) {
  return new Response(null, { status, headers: { location } });
}

// no-store by default: pages show secrets (enrollment key, device tokens, a fresh API token),
// so the back/forward cache must not restore one after Log out.
export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Form parsing (contract 10: malformed input -> 400 {detail}, never a 500)
// ---------------------------------------------------------------------------

// String field of a FormData: missing or a File -> fallback.
export function str(form, name, fallback = "") {
  const v = form.get(name);
  return typeof v === "string" ? v : fallback;
}

// Optional integer form field: '' -> null, non-integer -> 400 (web._form_int).
export function intField(value, field) {
  value = (value ?? "").toString().trim();
  if (!value) return null;
  if (!/^[+-]?\d+$/.test(value)) fail(400, `${field} must be a whole number`);
  return parseInt(value, 10);
}

// Optional float: '' -> null, junk / inf / nan -> 400 with `msg` (or a default).
export function floatField(value, field, msg) {
  value = (value ?? "").toString().trim();
  if (!value) return null;
  const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n)) fail(400, msg || `${field} must be a number`);
  return n;
}

// Path param that must be an integer id (FastAPI's `int` path converter -> our 400).
export function idParam(value, field = "id") {
  if (!/^\d+$/.test(value ?? "")) fail(400, `${field}: value is not a valid integer`);
  return parseInt(value, 10);
}

// Return zero-padded 'HH:MM' for a valid time string, or null if it is not one.
// Accepts '7:05' as well as '07:05' (both become '07:05'); rejects seconds, 24:00, etc.
export function normalizeHhmm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").toString().trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// 'YYYY-MM-DD' -> the same string when it is a real calendar date, else null.
export function isoDate(value) {
  const s = (value ?? "").toString().trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return s;
}

// Optional ISO date form field: '' -> null, malformed -> 400 (web._parse_iso_date).
export function isoDateField(value, field) {
  const s = (value ?? "").toString().trim();
  if (!s) return null;
  const d = isoDate(s);
  if (d === null) fail(400, `${field} must be a date in YYYY-MM-DD form`);
  return d;
}

// Request body as a JSON object or 400 (web._json_object).
export async function jsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, "body must be a JSON object");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail(400, "body must be a JSON object");
  return body;
}

// ---------------------------------------------------------------------------
// Time. The DB stores UTC 'YYYY-MM-DD HH:MM:SS' (sqlite datetime('now')).
// ---------------------------------------------------------------------------

export function nowUtc(date = new Date()) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// Parse a datetime('now') string (UTC) into a Date, or null.
export function parseDbUtc(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).trim().replace("T", " ");
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}

function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", timeZoneName: "short",
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// Wall-clock fields of `date` in `timeZone`: {year, month, day, hour, minute, second,
// weekday (0=Mon..6=Sun, Python convention), zone ('PDT')}. Schedules evaluate on this.
export function wallClock(timeZone, date = new Date()) {
  const p = partsIn(date, timeZone);
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    weekday: WEEKDAYS[p.weekday], zone: p.timeZoneName,
  };
}

// Numeric UTC offset of `timeZone` at `date`, in minutes (e.g. -420 for PDT).
export function zoneOffsetMinutes(timeZone, date = new Date()) {
  const w = wallClock(timeZone, date);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

const pad2 = (n) => String(n).padStart(2, "0");

// Render a UTC DB timestamp in the site zone, e.g. '2026-09-14 15:03 PDT' (Jinja `local` filter).
export function localTime(value, timeZone) {
  const d = parseDbUtc(value);
  if (!d) return value ? String(value) : "";
  const w = wallClock(timeZone, d);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)} ${w.zone}`;
}

// Current time in the site zone as ISO 8601 with numeric offset, seconds precision
// (manifest server_time; Python: datetime.now().astimezone().isoformat(timespec='seconds')).
export function serverTimeIso(timeZone, date = new Date()) {
  const w = wallClock(timeZone, date);
  const off = zoneOffsetMinutes(timeZone, date);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}T${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}` +
    `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

export function zoneName(timeZone, date = new Date()) {
  return wallClock(timeZone, date).zone;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return false;
  }
  if (tz === "UTC" || tz.startsWith("Etc/")) return true; // neither is listed by supportedValuesOf; Etc/GMT+12 is a real fixed-offset zone
  try {
    return Intl.supportedValuesOf("timeZone").includes(tz); // rejects EST/MST/PST etc., which ICU maps to fixed-offset zones
  } catch {
    return true; // runtime without supportedValuesOf: fall back to the Intl check
  }
}

export function ageText(seconds) {
  if (seconds === null || seconds === undefined) return "never";
  seconds = Math.max(0, Math.floor(seconds));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// Seconds between a DB timestamp and now, or null when unset.
export function ageSeconds(value, now = new Date()) {
  const d = parseDbUtc(value);
  return d ? (now.getTime() - d.getTime()) / 1000 : null;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// secrets.token_urlsafe(nbytes) equivalent.
export function randomToken(nbytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(nbytes)));
}

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", buf));
}

export function utf8Len(s) {
  return new TextEncoder().encode(s).length;
}

// Throttle key for a client address: IPv4 as is, IPv6 collapsed to its /64 (home and mobile
// users hold at least a /64, so rotating inside it must not reset a rate limit).
export function ipBucket(ip) {
  if (!ip || !ip.includes(":")) return ip || "-";
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":") + "::/64";
}

export function envInt(env, name, fallback) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envFloat(env, name, fallback) {
  const n = parseFloat(env[name]);
  return Number.isFinite(n) ? n : fallback;
}
