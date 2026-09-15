// Tiny method + pattern router. Patterns are literal paths with ':param' segments
// ('/devices/:device_id/schedule/:schedule_id/delete'); params arrive as strings in ctx.params.
// Each module exports register(router) and calls router.add(method, pattern, handler).
import { HttpError } from "./util.js";

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const names = [];
    const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/:([A-Za-z_]\w*)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
    this.routes.push({ method: method.toUpperCase(), pattern, re, names, handler });
    return this;
  }

  get(pattern, handler) { return this.add("GET", pattern, handler); }
  post(pattern, handler) { return this.add("POST", pattern, handler); }
  put(pattern, handler) { return this.add("PUT", pattern, handler); }

  // {handler, params} for the first route matching method + path; {status: 405} when only the
  // method differs (FastAPI does the same); null when nothing matches.
  match(method, path) {
    method = method.toUpperCase();
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method && !(r.method === "GET" && method === "HEAD")) {
        pathMatched = true;
        continue;
      }
      const params = {};
      r.names.forEach((n, i) => {
        // A broken percent sequence ('/playlists/%E0') is the caller's fault: 400, not a 500.
        try { params[n] = decodeURIComponent(m[i + 1]); } catch { throw new HttpError(400, "malformed path"); }
      });
      return { handler: r.handler, params, pattern: r.pattern };
    }
    return pathMatched ? { status: 405 } : null;
  }
}

export function isApiPath(path) {
  return path === "/api" || path.startsWith("/api/");
}
