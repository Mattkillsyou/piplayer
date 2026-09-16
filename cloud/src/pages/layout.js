// Port of templates/base.html (Projection5000 design). Pages build their content string
// (every value through esc()) and call layout(ctx, {title, content}) to get the HTML Response.
import { esc, html } from "../util.js";

export const APP_NAME = "Projection5000";
export const APP_EYEBROW = "Matt Brown's";

const NAV = [
  ["/dashboard", "Dashboard", (p) => p === "/dashboard"],
  ["/library", "Library"],
  ["/playlists", "Playlists"],
  ["/devices", "Devices"],
  ["/groups", "Groups"],
  ["/audit", "Audit"],
  ["/users", "Users", null, "admin"],
  ["/settings", "Settings", null, "admin"],
];

// Hidden CSRF input for a <form method="post"> (contract 8).
export function csrfInput(ctx) {
  return `<input type="hidden" name="csrf_token" value="${esc(ctx.csrf)}">`;
}

// A `<div class="alert error">` (or class 'ok' / 'warn') for the message slot, '' when message is empty.
export function alertBox(message, kind = "error") {
  return message ? `<div class="alert ${esc(kind)}" role="alert">${esc(message)}</div>` : "";
}

// The PROJECTION[5000] wordmark; `cursor` adds the blinking block used on the login card and
// `tag` picks the outer element (the auth card uses an h1 so .wordmark and h1 styles share it).
export function wordmark(cursor = false, tag = "span") {
  return `<${tag} class="wordmark">PROJECTION<span class="wordmark-key">5000</span>${cursor ? '<span class="wordmark-cursor" aria-hidden="true"></span>' : ""}</${tag}>`;
}

// Dashed "NO SIGNAL"-style empty state: title in the display face, one line of help, optional action HTML.
export function emptyState(title, text, action = "") {
  return `<div class="empty">
    <span class="empty-title">${esc(title)}</span>
    <p>${text}</p>
    ${action}
  </div>`;
}

// The wordmark lockup: eyebrow above, model number knocked out as a keycap. `large` is the
// login/setup card variant (an <h1> with the blinking cursor).
export function wordmark(large = false) {
  if (large) {
    return `<div class="wordmark wordmark-lg">
    <span class="wordmark-eyebrow">Matt Brown's</span>
    <h1 class="wordmark-mark">PROJECTION<span class="wordmark-model">5000</span><span class="wordmark-cursor"></span></h1>
  </div>`;
  }
  return `<a href="/dashboard" class="wordmark" aria-label="Matt Brown's Projection5000">
        <span class="wordmark-eyebrow">Matt Brown's</span>
        <span class="wordmark-mark">PROJECTION<span class="wordmark-model">5000</span></span>
      </a>`;
}

// The login scene layers (scanlines, floor, skyline, vignette) behind the auth card.
export const SCENE = `<div class="scene" aria-hidden="true">
  <div class="scene-scan"></div>
  <div class="scene-floor"></div>
  <div class="scene-skyline"><i></i><i></i><i></i></div>
  <div class="scene-vignette"></div>
</div>`;

function navHtml(ctx) {
  const user = ctx.user;
  const path = ctx.url.pathname;
  const links = NAV
    .filter(([, , , role]) => !role || user.role === role)
    .map(([href, label, test]) => {
      const active = test ? test(path) : path.startsWith(href);
      return `<a href="${href}"${active ? ' class="active"' : ""}>${label}</a>`;
    })
    .join("\n      ");
  return `<header class="topbar">
    <div class="brand">
      <a href="/dashboard" aria-label="${APP_NAME} dashboard">
        <span class="brand-eyebrow">${esc(APP_EYEBROW)}</span>
        ${wordmark()}
      </a>
    </div>
    <button type="button" class="nav-toggle" aria-label="Menu" aria-expanded="false" aria-controls="site-nav">&#8801;</button>
    <nav id="site-nav" aria-label="Console">
      ${links}
    </nav>
    <div class="user">
      <span class="username">${esc(user.username)}</span>
      <span class="badge badge-${esc(user.role)}">${esc(user.role)}</span>
      <form method="post" action="/logout" class="inline">
        ${csrfInput(ctx)}
        <button type="submit" class="link">Log out</button>
      </form>
    </div>
  </header>`;
}

// {title, content (already-escaped HTML), status, message, messageKind, scripts (extra
// <script src> paths under /static), bodyClass} -> Response.
export function layout(ctx, { title, content, status = 200, message = "", messageKind = "error", scripts = [], bodyClass = "" } = {}) {
  const fullTitle = title ? `${title} — ${APP_NAME}` : APP_NAME;
  const extra = scripts.map((s) => `<script src="${esc(s)}"></script>`).join("\n  ");
  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${esc(ctx.csrf)}">
  <title>${esc(fullTitle)}</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body class="${esc(bodyClass)}">
  ${ctx.user ? navHtml(ctx) : ""}
  <main class="container">
    ${alertBox(message, messageKind)}
    ${content}
  </main>
  ${extra}
  <script src="/static/app.js"></script>
</body>
</html>
`;
  return html(page, status);
}
