// Shared test plumbing: a cookie-carrying client over SELF.fetch, csrf extraction, setup.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";

export const BASE = "http://piplayer.test";
export const SETUP_TOKEN = "test-setup-token";

export class Client {
  constructor() { this.cookie = null; }

  async fetch(path, init = {}) {
    const headers = new Headers(init.headers || {});
    if (this.cookie) headers.set("cookie", this.cookie);
    const res = await SELF.fetch(BASE + path, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const kv = c.split(";")[0];
      this.cookie = kv.endsWith("=") ? null : kv;
    }
    return res;
  }

  get(path) { return this.fetch(path); }

  post(path, fields, headers = {}) {
    const body = new URLSearchParams(fields);
    return this.fetch(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
  }

  postJson(path, data, headers = {}) {
    return this.fetch(path, { method: "POST", body: JSON.stringify(data), headers: { "content-type": "application/json", ...headers } });
  }

  // CSRF token from the meta tag of any page.
  async csrf(path = "/login") {
    const text = await (await this.get(path)).text();
    const m = /<meta name="csrf-token" content="([^"]+)">/.exec(text);
    if (!m) throw new Error(`no csrf meta on ${path}: ${text.slice(0, 200)}`);
    return m[1];
  }

  async login(username, password) {
    const csrf_token = await this.csrf("/login");
    return this.post("/login", { username, password, csrf_token });
  }
}

export async function wipe() {
  await env.DB.batch(["sessions", "login_failures", "audit_log", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

// Create the first admin through /setup and return a logged-in client.
export async function setupAdmin(username = "admin", password = "test1234") {
  const c = new Client();
  const csrf_token = await c.csrf(`/setup?token=${SETUP_TOKEN}`);
  const r = await c.post("/setup", { token: SETUP_TOKEN, username, password, password2: password, csrf_token });
  if (r.status !== 303) throw new Error(`setup failed: ${r.status} ${await r.text()}`);
  return c;
}

export const query = (sql, ...params) => env.DB.prepare(sql).bind(...params).all().then((r) => r.results);
