// Worker entry: builds the router from every module, resolves the session + CSRF for web
// requests, dispatches, and turns thrown HttpError / Response / constraint errors into the
// contract-10 status codes. Any other exception is a JSON 500 (logged), never a stack trace.
import * as alerts from "./alerts.js";
import * as api from "./api.js";
import * as audit from "./audit.js";
import * as auth from "./auth.js";
import * as db from "./db.js";
import * as deviceCodes from "./device_codes.js";
import * as manifest from "./manifest.js";
import * as media from "./media.js";
import * as schedules from "./schedules.js";
import * as uploads from "./uploads.js";
import * as alertsPage from "./pages/alerts.js";
import * as auditPage from "./pages/audit.js";
import * as dashboard from "./pages/dashboard.js";
import * as devices from "./pages/devices.js";
import * as flasher from "./pages/flasher.js";
import * as groups from "./pages/groups.js";
import * as library from "./pages/library.js";
import * as login from "./pages/login.js";
import * as playlists from "./pages/playlists.js";
import * as schedule from "./pages/schedule.js";
import * as settings from "./pages/settings.js";
import * as setup from "./pages/setup.js";
import * as signup from "./pages/signup.js";
import * as users from "./pages/users.js";
import { layout } from "./pages/layout.js";
import { isApiPath, Router } from "./router.js";
import { esc, fail, HttpError, json, redirect } from "./util.js";

const MODULES = [
  login, setup, signup, dashboard, library, playlists, devices, schedule, groups, alertsPage, auditPage, users, settings, flasher,
  api, media, manifest, schedules, uploads, auth, audit, alerts, deviceCodes,
];

const router = new Router();
for (const m of MODULES) if (m.register) m.register(router);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// On every response, pages and JSON alike. frame-src stays "https:" because the Devices page
// frames any operator-pasted live camera URL; img-src needs data: for style.css's select arrow.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-src https:; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
};

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

function makeCtx(request, env, exec, url, params) {
  let formPromise = null;
  let settingsPromise = null;
  return {
    request, env, exec, url, params,
    user: null, session: null, csrf: null,
    ip: audit.clientIp({ request }),
    cookies: [],
    // Parsed form body (memoised; the CSRF check and the handler share one read).
    form() {
      if (!formPromise) {
        formPromise = request.formData().catch(() => fail(400, "malformed form body"));
      }
      return formPromise;
    },
    // Site settings {timezone, screenshot_interval, default_image_duration} (memoised).
    settings() {
      if (!settingsPromise) settingsPromise = db.loadSettings(env);
      return settingsPromise;
    },
  };
}

function withCookies(res, ctx) {
  if (!ctx || !ctx.cookies.length) return res;
  const out = new Response(res.body, res);
  for (const c of ctx.cookies) out.headers.append("set-cookie", c);
  return out;
}

// A browser (page navigation or form post: Accept has text/html) gets the message in the
// normal layout with a Back link; the device API, app.js/upload.js and scripts keep the JSON.
function errorResponse(ctx, status, detail, headers) {
  const wantsHtml = !isApiPath(ctx.url.pathname) && (ctx.request.headers.get("accept") || "").includes("text/html");
  if (!wantsHtml) return json({ detail }, status, headers);
  // The CSP allows no inline script, so Back is the same-origin referer (the page with the form).
  const referer = ctx.request.headers.get("referer") || "";
  const back = referer.startsWith(ctx.url.origin + "/") ? referer : "/dashboard";
  const res = layout(ctx, { title: "Something went wrong", status, message: detail, content: `<p><a href="${esc(back)}" class="back">← Back</a></p>` });
  for (const [k, v] of Object.entries(headers || {})) res.headers.set(k, v);
  return res;
}

async function handle(request, env, exec) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/static/")) {
    // public/ is the assets root, so /static/style.css is served from public/style.css.
    const assetUrl = new URL(path.slice("/static".length) + url.search, url);
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }
  await db.assertMigrated(env);

  const m = router.match(request.method, path);
  if (!m) fail(404, "Not Found");
  if (m.status) throw new HttpError(m.status, "Method Not Allowed", { allow: m.allow });

  const ctx = makeCtx(request, env, exec, url, m.params);
  try {
    if (isApiPath(path)) {
      // Device API: bearer auth inside the handlers; a browser session is only consulted
      // (never created) so /api/media can serve logged-in users too.
      await auth.loadSession(ctx, { create: false });
    } else {
      // Only the anonymous forms start a session (they need a CSRF token); everything
      // else just reads the cookie, so a cookieless GET /dashboard redirects without a write.
      // /setup after setup is a 404, so it gets no row either (hasUsers is memoised once true).
      const anonForm = path === "/login" || path === "/setup" || path === "/signup";
      await auth.loadSession(ctx, { create: anonForm && request.method === "GET" && !(path === "/setup" && await auth.hasUsers(env)) });
      if (!SAFE_METHODS.has(request.method)) {
        // Session gone (expired, logged out elsewhere, user deleted): the handler would answer
        // 303 -> /login anyway; do not leave a form on a JSON 403. A stale /login form (no
        // session at all) is sent back the same way and gets a fresh one from the GET.
        // Deliberately ahead of the token check, as in cms/app/auth.py require_csrf (X002):
        // nothing is written, and the 403 is reserved for a live session with a bad token.
        if (!ctx.user && !anonForm) throw redirect("/login?expired=1");
        if ((path === "/login" || path === "/signup") && !ctx.session) throw redirect(`${path}?expired=1`);
        await auth.requireCsrf(ctx);
      }
      if (path !== "/setup" && !(await auth.hasUsers(env))) throw new Response(null, { status: 303, headers: { location: "/setup" } });
    }
    return withCookies(await m.handler(ctx), ctx);
  } catch (e) {
    if (e instanceof Response) return withCookies(e, ctx);
    if (e instanceof HttpError) return withCookies(errorResponse(ctx, e.status, e.detail, e.headers), ctx);
    if (db.isConstraintError(e)) {
      // A constraint violation no route mapped itself: never a bare 500, never the sqlite text.
      console.error(`integrity error on ${request.method} ${path}: ${e.message}`);
      return withCookies(errorResponse(ctx, 409, "conflicts with an existing record or references one that does not exist"), ctx);
    }
    throw e;
  }
}

export default {
  async fetch(request, env, exec) {
    let res;
    try {
      res = await handle(request, env, exec);
    } catch (e) {
      if (e instanceof HttpError) {
        res = json({ detail: e.detail }, e.status, e.headers);
      } else {
        console.error(`unhandled error on ${request.method} ${new URL(request.url).pathname}:`, e && e.stack || e);
        res = json({ detail: "internal server error" }, 500);
      }
    }
    return withSecurityHeaders(res);
  },

  // wrangler.toml [triggers]: the */5 cron evaluates alerts; the daily one runs every
  // module's housekeeping(env) in turn.
  async scheduled(event, env, exec) {
    if (event.cron === alerts.CRON) {
      try {
        await alerts.evaluate(env);
      } catch (e) {
        console.error("alert evaluation failed:", e && e.stack || e);
      }
      return;
    }
    for (const m of MODULES) {
      if (!m.housekeeping) continue;
      try {
        await m.housekeeping(env);
      } catch (e) {
        console.error("housekeeping failed:", e && e.stack || e);
      }
    }
  },
};
