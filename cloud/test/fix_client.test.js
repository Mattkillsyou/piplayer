// The Library's scripts (public/media.js, public/upload.js) against stand-in elements, as in
// library_client_scripts.test.js (workerd has no DOM): the release's client fixes.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../public/sha256.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// --------------------------------------------------------------------------- a page of parts ---

// The viewer and Recently deleted need more of a page: parts in a tree, each matching the
// selectors in `is` (and its tag, and [hidden] while hidden), with text, focus and listeners.
let doc;
function part(tag, is = [], props = {}) {
  const on = {};
  const p = Object.assign({
    tagName: tag.toUpperCase(), is: [tag, ...is], children: [], parentNode: null, attrs: {}, dataset: {}, text: "",
    hidden: false, disabled: false, classes: new Set(),
    addEventListener(type, fn) { (on[type] ||= []).push(fn); },
    fire(type, e = {}) { for (const fn of on[type] || []) fn({ target: p, preventDefault() {}, ...e }); },
    matches: (sel) => (sel === "[hidden]" ? p.hidden : p.is.includes(sel)),
    closest: (sel) => (p.matches(sel) ? p : p.parentNode && p.parentNode.closest(sel)),
    contains: (x) => { while (x && x !== p) x = x.parentNode; return !!x; },
    querySelectorAll: (sel) => p.children.flatMap((c) => (c.matches(sel) ? [c] : []).concat(c.querySelectorAll(sel))),
    querySelector: (sel) => p.querySelectorAll(sel)[0] || null,
    appendChild: (c) => { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = p; p.children.push(c); return c; },
    removeChild: (c) => { p.children.splice(p.children.indexOf(c), 1); c.parentNode = null; return c; },
    insertBefore: (c, ref) => {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = p;
      const i = ref ? p.children.indexOf(ref) : -1;
      p.children.splice(i < 0 ? p.children.length : i, 0, c);
      return c;
    },
    setAttribute: (k, v) => { p.attrs[k] = String(v); },
    getAttribute: (k) => p.attrs[k] ?? null,
    removeAttribute: (k) => { delete p.attrs[k]; },
    focus: () => { doc.activeElement = p; },
  }, props);
  p.classList = { add: (c) => p.classes.add(c), remove: (c) => p.classes.delete(c), contains: (c) => p.classes.has(c) };
  Object.defineProperty(p, "textContent", {
    get: () => (tag === "#text" ? p.text : p.children.map((c) => c.textContent).join("")),
    set: (v) => { while (p.children.length) p.removeChild(p.children[0]); if (v !== "") p.appendChild(part("#text", [], { text: String(v) })); },
  });
  Object.defineProperty(p, "isConnected", { get: () => doc.body.contains(p) });
  Object.defineProperty(p, "nextSibling", { get: () => (p.parentNode && p.parentNode.children[p.parentNode.children.indexOf(p) + 1]) || null });
  return p;
}

// The viewer's <dialog>: media.js build()'s markup, read into parts.
function dialogPart() {
  const d = part("dialog", [], { open: false });
  d.showModal = () => { d.open = true; };
  d.close = () => { d.open = false; d.fire("close"); };
  Object.defineProperty(d, "innerHTML", {
    set() {
      const head = d.appendChild(part("div"));
      head.appendChild(part("span", [".viewer-name"]));
      head.appendChild(part("button", ["[data-close]"]));
      d.appendChild(part("div", [".viewer-stage"]));
      const foot = d.appendChild(part("div"));
      foot.appendChild(part("span", [".viewer-meta"]));
      for (const step of ["-1", "1"]) foot.appendChild(part("button", ["[data-step]", `[data-step="${step}"]`], { dataset: { step } }));
      for (const a of ["details", "download"]) foot.appendChild(part("a", [`[data-${a}]`]));
      foot.appendChild(part("button", ["[data-delete]"]));
    },
  });
  return d;
}

// Recently deleted as trashSection writes it, holding trash rows `ids` (newest first).
function trashPart(ids) {
  const details = part("details", ["details.trash"], { open: false });
  const form = details.appendChild(part("form"));
  const boxes = ids.map((id, i) => form.appendChild(part("input", ['input[name="trash_id"]', ...(i ? [] : ['details.trash input[name="trash_id"]'])],
    { name: "trash_id", type: "checkbox", value: String(id), checked: false, form })));
  const all = form.appendChild(part("button", ["[data-select-trash]"], { form }));
  all.textContent = "Select all";
  return { details, boxes, all };
}

// An editor's Library of `files` ([name, kind ("img" | "video")]) with media.js loaded at `path`:
// the grid's form with a card per file (tick box, preview, Delete), Find, the files line. `fetch`
// answers the script's requests.
async function loadPage(files, { fetch = async () => ({ ok: true, status: 200 }), path = "/library" } = {}) {
  const body = part("body");
  const docOn = {};
  doc = {
    body, activeElement: body,
    addEventListener(type, fn) { (docOn[type] ||= []).push(fn); },
    fire(type, e) { for (const fn of docOn[type] || []) fn({ preventDefault() {}, ...e }); },
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => (tag === "dialog" ? dialogPart() : part(tag, [], { pause() {}, load() {} })),
    createTextNode: (text) => part("#text", [], { text }),
    importNode: (n) => n,
  };
  body.appendChild(part("meta", ['meta[name="csrf-token"]'], { content: "tok" }));
  const line = body.appendChild(part("span", [".page-head .page-meta"]));
  line.textContent = `${files.length} files`;
  const form = body.appendChild(part("form", [], { action: "/library/delete", dataset: { max: "500" } }));
  for (const sel of ["[data-delete-selected]", "[data-select-all]", "[data-add-selected]", "[data-picked]"]) form.appendChild(part("span", [sel]));
  const grid = form.appendChild(part("ul", [".media-grid"]));
  const cards = files.map(([name, kind], i) => {
    const id = String(i + 1);
    const href = `/api/media/f${id}_${name}`;
    const card = grid.appendChild(part("li", [".media-card"], { dataset: { name, kind: kind === "img" ? "image" : "video", use: "none", size: "1000", length: "0" } }));
    card.appendChild(part("input", ['input[name="media_id"]'], { type: "checkbox", value: id, checked: false }));
    const link = card.appendChild(part("a", [".media-thumb", "a[data-view]"], { href, pathname: href, attrs: { href }, dataset: { kind, name, meta: "", page: `/library/${id}` } }));
    card.appendChild(part("button", ['button[name="one"]'], { value: id, form, dataset: { confirm: `Delete ${name}?` } }));
    return { card, link };
  });
  const ids = {
    "library-form": form, "add-to": part("select", [], { value: "" }), "media-find": part("div", [], { hidden: true }), "find-q": part("input", [], { value: "" }),
    "find-show": part("select", [], { value: "", selectedIndex: 0 }), "find-sort": part("select", [], { value: "", selectedIndex: 0 }), "media-count": part("h2"),
  };
  const Dialog = { prototype: { showModal() {} } };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { HTMLDialogElement: Dialog, addEventListener() {} });
  vi.stubGlobal("HTMLDialogElement", Dialog);
  vi.stubGlobal("sessionStorage", null);
  vi.stubGlobal("Image", function () { return part("img"); });
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal("location", { reload: vi.fn(), pathname: path });
  vi.stubGlobal("fetch", vi.fn(fetch));
  await import("../public/media.js");
  return { body, form, grid, cards, ids, line, fetch: globalThis.fetch, alert: globalThis.alert, reload: globalThis.location.reload };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const LIBRARY = "http://piplayer.test/library";
// A fetch whose answers wait until the test hands them out: answer(i, reply) settles the i-th call.
function held() {
  const waiting = [];
  const fetch = () => new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  return { fetch, answer: (i, reply) => (reply instanceof Error ? waiting[i].reject(reply) : waiting[i].resolve(reply)) };
}

describe("media.js viewer", () => {
  const FILES3 = [["a.mp4", "video"], ["b.png", "img"], ["c.png", "img"]];
  const open = (p, i) => { p.cards[i].link.focus(); doc.fire("click", { target: p.cards[i].link, button: 0 }); };
  const viewer = () => {
    const d = doc.body.querySelector("dialog");
    const q = (sel) => d.querySelector(sel);
    return { d, name: q(".viewer-name"), close: q("[data-close]"), prev: q('[data-step="-1"]'), next: q('[data-step="1"]'), details: q("[data-details]"), del: q("[data-delete]") };
  };

  it("Delete of the last file on show closes the viewer and puts the focus on Find", async () => {
    const p = await loadPage(FILES3, { fetch: async () => ({ ok: true, status: 200, url: LIBRARY }) });
    p.ids["find-q"].value = "b.png";
    p.ids["find-q"].fire("input");
    expect(p.ids["media-count"].textContent).toBe("Media (1 of 3)");
    open(p, 1);
    const v = viewer();
    v.del.focus();
    v.d.fire("click", { target: v.del });
    await vi.waitFor(() => expect(v.d.open).toBe(false));
    expect([p.ids["media-count"].textContent, doc.activeElement]).toEqual(["Media (0 of 2)", p.ids["find-q"]]);
    // a file still on the page gets the focus back as before
    p.ids["find-q"].value = "";
    p.ids["find-q"].fire("input");
    open(p, 0);
    v.next.focus();
    v.d.fire("click", { target: v.next });
    v.d.fire("click", { target: v.close });
    expect(doc.activeElement).toBe(p.cards[2].link);
  });

  it("Details is left out on the file's own page", async () => {
    const p = await loadPage(FILES3, { path: "/library/2" });
    open(p, 1);
    const v = viewer();
    expect(v.details.hidden).toBe(true);
    v.d.fire("click", { target: v.next });
    expect([v.details.hidden, v.details.href]).toEqual([false, "/library/3"]);
  });

  it("the viewer moved on before Delete's answer: Previous / Next are put right once the file is gone", async () => {
    const h = held();
    const p = await loadPage(FILES3, { fetch: h.fetch });
    open(p, 0);
    const v = viewer();
    expect(v.prev.disabled).toBe(true);
    v.d.fire("click", { target: v.del });
    v.d.fire("click", { target: v.next });
    expect([v.name.textContent, v.prev.disabled]).toEqual(["b.png", false]);
    h.answer(0, { ok: true, status: 200, url: LIBRARY });
    await vi.waitFor(() => expect(p.grid.children.length).toBe(2));
    expect([v.name.textContent, v.prev.disabled, v.next.disabled]).toEqual(["b.png", true, false]);
    // the same at the other end, with the focus on Next: both steps go off, the focus to Close
    open(p, 2); // c.png, the last
    v.d.fire("click", { target: v.del });
    v.d.fire("click", { target: v.prev });
    v.next.focus();
    h.answer(1, { ok: true, status: 200, url: LIBRARY });
    await vi.waitFor(() => expect(p.grid.children.length).toBe(1));
    expect([v.name.textContent, v.prev.disabled, v.next.disabled, doc.activeElement]).toEqual(["b.png", true, true, v.close]);
  });

  it("two deletes whose answers cross: the older Library page is dropped, in either order", async () => {
    // A page the delete came back to: its files line and its Recently deleted, newest row `top`.
    const pages = {};
    const page = (key, text, top) => {
      const meta = part("span");
      meta.textContent = text;
      const trash = trashPart([top, top - 1]);
      pages[key] = { meta, trash: trash.details, top: trash.boxes[0] };
    };
    page("after-a", "2 files", 10);
    page("after-both", "1 file", 11);
    vi.stubGlobal("DOMParser", function () {
      this.parseFromString = (html) => ({
        querySelector: (sel) => ({ ".page-head .page-meta": pages[html].meta, "details.trash": pages[html].trash, 'details.trash input[name="trash_id"]': pages[html].top })[sel] || null,
      });
    });
    const reply = (key) => ({ ok: true, status: 200, url: LIBRARY, text: async () => key });
    let h = held();
    let p = await loadPage(FILES3, { fetch: h.fetch });
    open(p, 0);
    let v = viewer();
    v.d.fire("click", { target: v.del }); // a.mp4
    v.d.fire("click", { target: v.next });
    v.d.fire("click", { target: v.del }); // b.png
    h.answer(1, reply("after-both")); // the second answer first
    await vi.waitFor(() => expect(p.line.textContent).toBe("1 file"));
    h.answer(0, reply("after-a"));
    await vi.waitFor(() => expect(p.grid.children.length).toBe(1));
    for (let i = 0; i < 5; i++) await tick();
    expect([p.line.textContent, doc.body.querySelector("details.trash")]).toEqual(["1 file", pages["after-both"].trash]);

    vi.resetModules(); // and in the order sent, the newer page last: it is applied
    page("after-a", "2 files", 10);
    page("after-both", "1 file", 11);
    h = held();
    p = await loadPage(FILES3, { fetch: h.fetch });
    open(p, 0);
    v = viewer();
    v.d.fire("click", { target: v.del });
    v.d.fire("click", { target: v.next });
    v.d.fire("click", { target: v.del });
    h.answer(0, reply("after-a"));
    await vi.waitFor(() => expect(p.line.textContent).toBe("2 files"));
    h.answer(1, reply("after-both"));
    await vi.waitFor(() => expect(p.line.textContent).toBe("1 file"));
    expect(doc.body.querySelector("details.trash")).toBe(pages["after-both"].trash);
  });

  it("a refused Delete says the file was not deleted before the reload; signed out or a failed page load only reload", async () => {
    const h = held();
    const p = await loadPage(FILES3, { fetch: h.fetch });
    open(p, 0);
    const v = viewer();
    const answers = [
      { ok: false, status: 403, url: "http://piplayer.test/library/delete" }, // a stale token: said
      { ok: true, status: 200, url: "http://piplayer.test/login?expired=1" }, // signed out
      { ok: false, status: 500, url: LIBRARY }, // the delete went through; the page after it did not load
      new TypeError("Failed to fetch"), // no answer
    ];
    for (const [i, reply] of answers.entries()) {
      v.d.fire("click", { target: v.del });
      h.answer(i, reply);
      await vi.waitFor(() => expect(p.reload).toHaveBeenCalledTimes(i + 1));
      expect(p.alert.mock.calls).toEqual([["The file was not deleted (error 403). Reloading the page."]]);
    }
    expect(p.grid.children.length).toBe(3);
  });
});
