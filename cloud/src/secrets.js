// Encrypted credentials. Each account's own (the Wyze account, the Twilio credentials) live in
// `account_secrets(user_id, name, value)` (migration 0016; before it, one site-wide `secrets`
// table, which only /setup still reads to adopt rows from before any user existed). Values are
// AES-256-GCM ciphertext under a key HKDF-derived from the SESSION_SECRET worker secret (info
// "p5k-secrets"), so a D1 dump alone reveals nothing and rotating SESSION_SECRET invalidates every
// stored secret (Settings then shows them as not set: re-enter them). Nothing here renders a value;
// the pages only ask names() / wyzeConfigured().
import * as db from "./db.js";
import { b64url, fromB64url, HttpError } from "./util.js";

export const HKDF_INFO = "p5k-secrets";
const VERSION = "v1";
// An account secret: bound to its account as well as its name (accountAd), so a ciphertext copied
// to another account's row does not decrypt. 'v1' values were moved here from the site-wide table
// by migration 0016 (bound to the name only); housekeeping rewrites them as v2.
const ACCOUNT_VERSION = "v2";
const accountAd = (ownerId, name) => `${ownerId}/${name}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesKey(env) {
  if (!env.SESSION_SECRET) throw new HttpError(500, "SESSION_SECRET is not configured");
  const base = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(HKDF_INFO) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// '<version>:<iv b64url>:<ciphertext+tag b64url>'; a fresh 96-bit iv per call, `ad` is bound as
// additional data.
async function seal(env, version, ad, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(ad) }, await aesKey(env), enc.encode(plaintext));
  return `${version}:${b64url(iv)}:${b64url(ct)}`;
}

// The plaintext, or null when the value is malformed, of another version, tampered with or was
// encrypted under another SESSION_SECRET (treated as "not set", never a 500).
async function open(env, version, ad, stored) {
  try {
    const [v, iv, ct] = String(stored).split(":");
    if (v !== version || !iv || !ct) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(ad) }, await aesKey(env), fromB64url(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// A value bound to `name` alone ('v1:...'): the per-device RTSP URL (name rtsp:<device_id>).
export const encrypt = (env, name, plaintext) => seal(env, VERSION, name, plaintext);
export const decrypt = (env, name, stored) => open(env, VERSION, name, stored);

// An account secret's plaintext from its stored value: v2 (bound to the account) or a v1 moved
// here by migration 0016 (bound to the name).
function openAccount(env, ownerId, name, stored) {
  return String(stored).startsWith(`${ACCOUNT_VERSION}:`)
    ? open(env, ACCOUNT_VERSION, accountAd(ownerId, name), stored)
    : open(env, VERSION, name, stored);
}

// Store (replace) one of the account's secrets; an empty value deletes the row.
export async function set(env, ownerId, name, value) {
  if (!value) return db.run(env, "DELETE FROM account_secrets WHERE user_id = ? AND name = ?", ownerId, name);
  return db.run(env, `INSERT INTO account_secrets (user_id, name, value, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ownerId, name, await seal(env, ACCOUNT_VERSION, accountAd(ownerId, name), value));
}

export async function get(env, ownerId, name) {
  const row = await db.first(env, "SELECT value FROM account_secrets WHERE user_id = ? AND name = ?", ownerId, name);
  return row ? openAccount(env, ownerId, name, row.value) : null;
}

// {name: plaintext | null} for several of the account's names in one statement.
export async function getMany(env, ownerId, names) {
  const out = Object.fromEntries(names.map((n) => [n, null]));
  if (ownerId === null || ownerId === undefined) return out;
  for (const row of await db.all(env, `SELECT name, value FROM account_secrets WHERE user_id = ? AND name IN (${names.map(() => "?").join(", ")})`, ownerId, ...names)) {
    out[row.name] = await openAccount(env, ownerId, row.name, row.value);
  }
  return out;
}

// The account's names whose stored value still decrypts (the Settings page's set / not set): a
// row written under another SESSION_SECRET is "not set", so a rotation shows up on the page
// instead of silently answering source "none" to every player. At most eight rows per account.
export async function names(env, ownerId) {
  const out = new Set();
  if (ownerId === null || ownerId === undefined) return out;
  for (const r of await db.all(env, "SELECT name, value FROM account_secrets WHERE user_id = ?", ownerId)) {
    if (await openAccount(env, ownerId, r.name, r.value) !== null) out.add(r.name);
  }
  return out;
}

// Wyze account (Settings page): the four secrets the wyze-bridge needs. "Configured" means
// email and password are present; the API id/key pair is what the Wyze developer portal issues.
export const WYZE_NAMES = ["wyze_email", "wyze_password", "wyze_api_id", "wyze_api_key"];

export async function wyzeConfigured(env, ownerId) {
  const have = await names(env, ownerId);
  return have.has("wyze_email") && have.has("wyze_password");
}

// Map(ownerId -> wyzeConfigured) for several accounts in one statement (the Devices page of an
// admin labels each projector's camera default by its own account's login).
export async function wyzeConfiguredFor(env, ownerIds) {
  const ids = new Set(ownerIds.filter((id) => id !== null && id !== undefined));
  const have = new Map([...ids].map((id) => [id, new Set()]));
  if (!ids.size) return new Map();
  const rows = ids.size === 1
    ? await db.all(env, "SELECT user_id, name, value FROM account_secrets WHERE user_id = ? AND name IN ('wyze_email', 'wyze_password')", [...ids][0])
    : await db.all(env, "SELECT user_id, name, value FROM account_secrets WHERE name IN ('wyze_email', 'wyze_password')");
  for (const r of rows) {
    if (have.has(r.user_id) && await openAccount(env, r.user_id, r.name, r.value) !== null) have.get(r.user_id).add(r.name);
  }
  return new Map([...have].map(([id, set]) => [id, set.has("wyze_email") && set.has("wyze_password")]));
}

// Daily cron (index.js MODULES): a value migration 0016 moved over from the site-wide table is
// bound to its name only; rewrite it bound to its account too, so it cannot be copied into another
// account's row. A value that no longer decrypts (another SESSION_SECRET) is left for the owner
// to re-enter. Returns how many were rewritten.
export async function housekeeping(env) {
  let n = 0;
  for (const r of await db.all(env, `SELECT user_id, name, value FROM account_secrets WHERE value NOT LIKE '${ACCOUNT_VERSION}:%'`)) {
    const plain = await open(env, VERSION, r.name, r.value);
    if (plain === null) continue;
    await db.run(env, "UPDATE account_secrets SET value = ? WHERE user_id = ? AND name = ? AND value = ?",
      await seal(env, ACCOUNT_VERSION, accountAd(r.user_id, r.name), plain), r.user_id, r.name, r.value);
    n++;
  }
  return n;
}
