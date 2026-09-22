// /forgot and /reset (pages/forgot.js): the reset mail, the same card whatever the input, the
// per-address and per-account caps, and the token's one use.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import { EXPIRED_MSG, FORGOTS_PER_IP, mail, MAIL_SUBJECT, RESETS_PER_HOUR, SENT_MSG } from "../src/pages/forgot.js";
import { sha256Hex } from "../src/util.js";
import { BASE, Client, query, wipe } from "./helpers.js";
import { audits, one, post, roles } from "./pages_common.js";

let r, edId;
let sent = [];
const rows = () => query("SELECT user_id, token_hash, used_at, ip, expires_at > datetime('now') AS live FROM password_resets ORDER BY id");
const tokenOf = (m) => new URL(m.text.split("\n")[0]).searchParams.get("token");

async function forgot(who, ip = "198.51.100.40") {
  const c = new Client();
  const csrf_token = await c.csrf("/forgot");
  const res = await c.post("/forgot", { who, csrf_token }, { "cf-connecting-ip": ip });
  await mail.last; // the rows and the mail are written after the reply (waitUntil)
  return res;
}

async function reset(token, password, password2 = password) {
  const c = new Client();
  const csrf_token = await c.csrf("/forgot");
  return c.post("/reset", { token, password, password2, csrf_token });
}

beforeAll(async () => {
  await wipe();
  r = await roles();
  edId = r.ids.editor;
  await query("UPDATE users SET email = 'Ed@Example.com' WHERE id = ?", edId);
});

afterEach(() => { mail.send = async (m) => { sent.push(m); }; sent = []; vi.restoreAllMocks(); });
mail.send = async (m) => { sent.push(m); };

describe("forgot password", () => {
  it("the card is linked from the sign-in card and the home page; a signed-in user is sent to the dashboard", async () => {
    expect(await (await new Client().get("/login")).text()).toContain('<a href="/forgot">forgot password</a>');
    expect(await (await new Client().get("/")).text()).toContain('<p class="foot"><a href="/forgot">Forgot password</a></p>');
    const page = await new Client().get("/forgot");
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Forgot your password?");
    expect(text).toContain('name="who"');
    expect(text).toContain("Send reset link");
    expect(text).toContain('<a href="/login">back to sign in</a>');
    expect(text).toContain('name="csrf_token"');
    for (const path of ["/forgot", "/reset?token=x"]) {
      const mine = await r.viewer.get(path);
      expect([mine.status, mine.headers.get("location")], path).toEqual([303, "/dashboard"]);
    }
  });

  it("mails a link whose token hashes to the stored row, by username or by email in any case", async () => {
    await query("DELETE FROM password_resets");
    for (const who of ["ed", "ed@example.com", "ED@EXAMPLE.COM"]) {
      const res = await forgot(who);
      expect(res.status, who).toBe(200);
      expect(await res.text()).toContain(`<div class="alert ok" role="alert">${SENT_MSG}</div>`);
    }
    expect(sent).toHaveLength(3);
    const m = sent[2];
    expect(m).toMatchObject({ from: "no-reply@photogen5000.com", to: "Ed@Example.com", subject: MAIL_SUBJECT });
    const [link, ...lines] = m.text.trim().split("\n");
    expect(link.startsWith(`${BASE}/reset?token=`)).toBe(true);
    expect(lines).toEqual(["The link works for 30 minutes.", "If you did not ask for this, ignore this message."]);
    // every link stays live until one is used: a stranger naming the account cannot kill the
    // link its owner holds (resetSubmit retires them all together)
    const all = await rows();
    expect(all).toHaveLength(3);
    expect(all.map((x) => x.live)).toEqual([1, 1, 1]);
    expect(all[2]).toMatchObject({ user_id: edId, token_hash: await sha256Hex(tokenOf(m)), used_at: null, ip: "198.51.100.40" });
    expect(all[2].token_hash).not.toContain(tokenOf(m));
    const a = (await audits("password_reset_requested"))[0];
    expect(a).toMatchObject({ username: "ed", target_id: String(edId), ip: "198.51.100.40" });
    expect(JSON.stringify(a)).not.toContain(tokenOf(m));
  });

  it("an unknown account and one without an email get the same card and no mail", async () => {
    await query("DELETE FROM password_resets");
    for (const who of ["nobody", "nobody@example.com", "admin", ""]) {
      const res = await forgot(who, "198.51.100.41");
      expect(res.status, who).toBe(200);
      expect(await res.text(), who).toContain(SENT_MSG);
    }
    expect(sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it(`answers 429 after ${FORGOTS_PER_IP} requests from one address`, async () => {
    await query("DELETE FROM login_failures");
    for (let i = 0; i < FORGOTS_PER_IP; i++) expect((await forgot("nobody", "198.51.100.42")).status).toBe(200);
    const res = await forgot("ed", "198.51.100.42");
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Too many requests from this address; try again in");
    expect(sent).toEqual([]);
    expect((await forgot("ed", "198.51.100.43")).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it(`sends at most ${RESETS_PER_HOUR} links per account per hour`, async () => {
    await query("DELETE FROM login_failures");
    await query("DELETE FROM password_resets");
    for (let i = 0; i < RESETS_PER_HOUR; i++) expect((await forgot("ed", `198.51.100.${50 + i}`)).status).toBe(200);
    expect(sent).toHaveLength(RESETS_PER_HOUR);
    const res = await forgot("ed", "198.51.100.60");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SENT_MSG);
    expect(sent).toHaveLength(RESETS_PER_HOUR);
    expect(await rows()).toHaveLength(RESETS_PER_HOUR);
    // rows older than an hour do not count
    await query("UPDATE password_resets SET created_at = datetime('now', '-2 hours')");
    expect((await forgot("ed", "198.51.100.61")).status).toBe(200);
    expect(sent).toHaveLength(RESETS_PER_HOUR + 1);
  });

  it("a failed send still gets the same card and audits password_reset_mail_failed", async () => {
    await query("DELETE FROM login_failures");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mail.send = async () => { throw new Error("destination not verified"); };
    const res = await forgot("ed", "198.51.100.62");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SENT_MSG);
    expect((await audits("password_reset_mail_failed"))[0]).toMatchObject({ target_id: String(edId) });
    expect(errors.mock.calls[0][0]).toContain("destination not verified");
  });
});

describe("reset", () => {
  let token;
  beforeAll(async () => {
    await query("DELETE FROM login_failures");
    await query("DELETE FROM password_resets");
    mail.send = async (m) => { sent.push(m); };
    await forgot("ed", "198.51.100.70");
    token = tokenOf(sent[0]);
  });

  it("renders the form for a live token; a bad one is 400 with a link to ask again", async () => {
    const page = await new Client().get(`/reset?token=${token}`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Choose a new password");
    expect(text).toContain(`<input type="hidden" name="token" value="${token}">`);
    expect(text).toContain('autocomplete="new-password"');
    expect(text).toContain("Change password");
    expect(text).not.toMatch(/(src|href)="https?:\/\//);
    for (const bad of ["/reset", "/reset?token=", "/reset?token=nope"]) {
      const res = await new Client().get(bad);
      expect(res.status, bad).toBe(400);
      const t = await res.text();
      expect(t).toContain(EXPIRED_MSG);
      expect(t).toContain('<a href="/forgot">request a new one</a>');
      expect(t).not.toContain('name="password"');
    }
  });

  it("re-renders on a short or mismatched password; a bad token is refused on POST too", async () => {
    let res = await reset(token, "pw1");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(auth.PASSWORD_TOO_SHORT_MSG);
    res = await reset(token, "pw123456", "pw123457");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("The two passwords do not match");
    res = await reset("nope", "pw123456");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(EXPIRED_MSG);
    expect((await one("SELECT password_hash FROM users WHERE id = ?", edId)).password_hash).toMatch(/^pbkdf2\$/);
    expect((await new Client().login("ed", "editor-pass")).status).toBe(303);
  });

  it("needs a live form session and the matching csrf token", async () => {
    for (const [path, fields] of [["/forgot", { who: "ed" }], ["/reset", { token, password: "pw123456", password2: "pw123456" }]]) {
      const cold = await new Client().post(path, fields);
      expect([cold.status, cold.headers.get("location")], path).toEqual([303, `${path}?expired=1`]);
      const c = new Client();
      await c.csrf("/forgot");
      expect((await c.post(path, { ...fields, csrf_token: "nope" })).status, path).toBe(403);
    }
    expect(await (await new Client().get("/forgot?expired=1")).text()).toContain("had expired");
    const lapsed = await new Client().get("/reset?expired=1"); // the form session lapsed, the link may still be good
    expect(lapsed.status).toBe(400);
    const lapsedText = await lapsed.text();
    expect(lapsedText).toContain("open the link from the email again");
    expect(lapsedText).not.toContain(EXPIRED_MSG);
    expect((await new Client().login("ed", "editor-pass")).status).toBe(303);
    expect(sent).toEqual([]);
  });

  it("changes the password, ends every session of the user, audits, and the token works once", async () => {
    expect((await r.editor.get("/dashboard")).status).toBe(200);
    const res = await reset(token, "brand-new-1");
    expect([res.status, res.headers.get("location")]).toEqual([303, "/login"]);
    const c = new Client();
    c.flash = res.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => x.startsWith("piplayer_flash="));
    expect(await (await c.get("/login")).text()).toContain("Password changed. Sign in with the new one.");
    expect((await new Client().login("ed", "editor-pass")).status).toBe(200);
    expect((await new Client().login("ed", "brand-new-1")).status).toBe(303);
    expect((await r.editor.get("/dashboard")).headers.get("location")).toBe("/login");
    expect((await rows()).map((x) => x.used_at)).toEqual([expect.any(String)]);
    expect((await audits("password_reset"))[0]).toMatchObject({ username: "ed", target_id: String(edId) });
    // once
    expect((await new Client().get(`/reset?token=${token}`)).status).toBe(400);
    const again = await reset(token, "another-pw-1");
    expect(again.status).toBe(400);
    expect(await again.text()).toContain(EXPIRED_MSG);
    expect((await new Client().login("ed", "brand-new-1")).status).toBe(303);
  });

  it("an admin setting the password or the email retires any link still in the air", async () => {
    for (const [path, fields] of [[`/users/${edId}/password`, { password: "admin-set-1" }], [`/users/${edId}/email`, { email: "ed.new@example.com" }]]) {
      await query("DELETE FROM password_resets");
      await forgot("ed", "198.51.100.80");
      const t = tokenOf(sent[sent.length - 1]);
      expect((await new Client().get(`/reset?token=${t}`)).status).toBe(200);
      expect((await post(r.admin, path, fields)).status, path).toBe(303);
      expect((await new Client().get(`/reset?token=${t}`)).status, path).toBe(400);
      expect((await reset(t, "attacker-pw-1")).status, path).toBe(400);
    }
    await query("UPDATE users SET email = 'Ed@Example.com', password_hash = ? WHERE id = ?", await auth.hashPassword("brand-new-1"), edId);
  });

  it("an expired token is refused", async () => {
    await query("DELETE FROM password_resets");
    await forgot("ed", "198.51.100.71");
    const t = tokenOf(sent[0]);
    expect((await new Client().get(`/reset?token=${t}`)).status).toBe(200);
    await query("UPDATE password_resets SET expires_at = datetime('now', '-1 minute')");
    expect((await new Client().get(`/reset?token=${t}`)).status).toBe(400);
    expect((await reset(t, "pw123456")).status).toBe(400);
    expect((await new Client().login("ed", "brand-new-1")).status).toBe(303);
  });

  it("housekeeping drops rows older than a day and keeps the rest", async () => {
    await query("DELETE FROM password_resets");
    await query("INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, 'old', datetime('now'), datetime('now', '-25 hours'))", edId);
    await query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, 'new', datetime('now'))", edId);
    await auth.housekeeping(env);
    expect((await rows()).map((x) => x.token_hash)).toEqual(["new"]);
  });
});
