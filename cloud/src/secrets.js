// Encrypted key/value store for operator credentials (Wyze account, later Twilio): D1 table
// `secrets(name, value)`. Values are AES-256-GCM ciphertext under a key HKDF-derived from the
// SESSION_SECRET worker secret (info "p5k-secrets"), so a D1 dump alone reveals nothing and
// rotating SESSION_SECRET invalidates every stored secret (Settings then shows them as not
// set: re-enter them). Nothing here renders a value; the pages only ask isSet()/names().
import * as db from "./db.js";
import { b64url, fromB64url, HttpError } from "./util.js";

export const HKDF_INFO = "p5k-secrets";
const VERSION = "v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesKey(env) {
  if (!env.SESSION_SECRET) throw new HttpError(500, "SESSION_SECRET is not configured");
  const base = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(HKDF_INFO) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// 'v1:<iv b64url>:<ciphertext+tag b64url>'; a fresh 96-bit iv per call, `name` is bound as
// additional data so a ciphertext copied to another row does not decrypt.
export async function encrypt(env, name, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(name) }, await aesKey(env), enc.encode(plaintext));
  return `${VERSION}:${b64url(iv)}:${b64url(ct)}`;
}

// The plaintext, or null when the value is malformed, tampered with or was encrypted under
// another SESSION_SECRET (treated as "not set", never a 500).
export async function decrypt(env, name, stored) {
  try {
    const [v, iv, ct] = String(stored).split(":");
    if (v !== VERSION || !iv || !ct) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(name) }, await aesKey(env), fromB64url(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// Store (replace) a secret; an empty value deletes the row.
export async function set(env, name, value) {
  if (!value) return db.run(env, "DELETE FROM secrets WHERE name = ?", name);
  return db.run(env, `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, name, await encrypt(env, name, value));
}

export async function get(env, name) {
  const row = await db.first(env, "SELECT value FROM secrets WHERE name = ?", name);
  return row ? decrypt(env, name, row.value) : null;
}

// {name: plaintext | null} for several names in one statement.
export async function getMany(env, names) {
  const out = Object.fromEntries(names.map((n) => [n, null]));
  for (const row of await db.all(env, `SELECT name, value FROM secrets WHERE name IN (${names.map(() => "?").join(", ")})`, ...names)) {
    out[row.name] = await decrypt(env, row.name, row.value);
  }
  return out;
}

// Names whose stored value still decrypts (the Settings page's set / not set): a row written
// under another SESSION_SECRET is "not set", so a rotation shows up on the page instead of
// silently answering source "none" to every player. Four rows, so decrypting each is cheap.
export async function names(env) {
  const out = new Set();
  for (const r of await db.all(env, "SELECT name, value FROM secrets")) {
    if (await decrypt(env, r.name, r.value) !== null) out.add(r.name);
  }
  return out;
}

// Wyze account (Settings page): the four secrets the wyze-bridge needs. "Configured" means
// email and password are present; the API id/key pair is what the Wyze developer portal issues.
export const WYZE_NAMES = ["wyze_email", "wyze_password", "wyze_api_id", "wyze_api_key"];

export async function wyzeConfigured(env) {
  const have = await names(env);
  return have.has("wyze_email") && have.has("wyze_password");
}
