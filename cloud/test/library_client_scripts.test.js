// The Library's scripts against a few stand-in elements (workerd has no DOM): media.js's Find /
// Show / Sort and its media bar (Delete selected, Add to playlist, Select all), its previews and
// its viewer; upload.js sending the upload box's "Add to" with the complete request, an animated
// GIF's running time and its sizes; app.js asking before a destructive submit.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../public/sha256.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// An element: its data and state, its listeners (fire() calls them), and whatever `props` adds.
function el(props = {}) {
  const on = {};
  return Object.assign({
    dataset: {}, hidden: false, disabled: false, checked: false, textContent: "", value: "", selectedIndex: 0,
    addEventListener(type, fn) { (on[type] ||= []).push(fn); },
    fire(type) { for (const fn of on[type] || []) fn({ target: this, preventDefault() {} }); },
  }, props);
}

// An editor's Library: one card per [name, kind, use, size, length], newest first, and the page
// round them; `store` is the tab's sessionStorage (null: switched off).
async function library(files, store, max = "3") {
  const cards = files.map(([name, kind, use, size, length]) => {
    const card = el({ dataset: { name, kind, use, size: String(size), length: String(length) } });
    card.box = el({ type: "checkbox", closest: (sel) => (sel === ".media-card" || (sel === "[hidden]" && card.hidden) ? card : null) });
    card.querySelector = () => card.box;
    return card;
  });
  const grid = { children: [...cards], appendChild(c) { this.children.splice(this.children.indexOf(c), 1); this.children.push(c); } };
  const bar = { bulk: el(), all: el(), add: el(), picked: el() };
  const form = el({
    dataset: { max }, querySelectorAll: () => grid.children.map((c) => c.box),
    querySelector: (sel) => ({ "[data-delete-selected]": bar.bulk, "[data-select-all]": bar.all, "[data-add-selected]": bar.add, "[data-picked]": bar.picked })[sel] || null,
  });
  const ids = { "library-form": form, "add-to": el(), "media-find": el({ hidden: true }), "find-q": el(), "find-show": el(), "find-sort": el(), "media-count": el() };
  vi.stubGlobal("window", { addEventListener() {} });
  vi.stubGlobal("sessionStorage", store && { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } });
  vi.stubGlobal("document", {
    addEventListener() {}, getElementById: (id) => ids[id] || null,
    querySelector: (sel) => (sel === ".media-grid" ? grid : null), querySelectorAll: () => [],
  });
  await import("../public/media.js");
  // A pick in a box; the playlist box sits inside the form, where its change bubbles to.
  const set = (id, value, type = "change") => { ids[id].value = value; ids[id].fire(type); if (id === "add-to") form.fire(type); };
  const tick = (...names) => { for (const c of cards) c.box.checked = names.includes(c.dataset.name); form.fire("change"); };
  return { ...bar, ids, set, tick, count: () => ids["media-count"].textContent, shown: () => grid.children.filter((c) => !c.hidden).map((c) => c.dataset.name) };
}

const FILES = [
  ["Zed.png", "image", "none", 100, 0],
  ["Clip 10.mp4", "video", "default", 300, 12],
  ["lobby poster.png", "image", "playlist", 900, 0],
  ["Clip 2.mp4", "video", "default", 200, 30],
];

describe("media.js Find / Show / Sort", () => {
  it("shows the bar, hides what does not match, orders the cards, counts what is shown", async () => {
    const p = await library(FILES, {});
    expect(p.ids["media-find"].hidden).toBe(false);
    expect([p.count(), p.shown()]).toEqual(["Media (4)", ["Zed.png", "Clip 10.mp4", "lobby poster.png", "Clip 2.mp4"]]);
    p.set("find-sort", "name");
    expect(p.shown()).toEqual(["Clip 2.mp4", "Clip 10.mp4", "lobby poster.png", "Zed.png"]); // A to Z, any case, 2 before 10
    p.set("find-sort", "size");
    expect(p.shown()).toEqual(["lobby poster.png", "Clip 10.mp4", "Clip 2.mp4", "Zed.png"]);
    p.set("find-sort", "length");
    expect(p.shown()).toEqual(["Clip 2.mp4", "Clip 10.mp4", "Zed.png", "lobby poster.png"]); // equal lengths: newest first
    p.set("find-sort", "oldest");
    expect(p.shown()).toEqual(["Clip 2.mp4", "lobby poster.png", "Clip 10.mp4", "Zed.png"]);
    p.set("find-sort", "");
    expect(p.shown()).toEqual(["Zed.png", "Clip 10.mp4", "lobby poster.png", "Clip 2.mp4"]);

    for (const [show, expected] of [["video", ["Clip 10.mp4", "Clip 2.mp4"]], ["image", ["Zed.png", "lobby poster.png"]],
      ["default", ["Clip 10.mp4", "Clip 2.mp4"]], ["none", ["Zed.png"]], ["", ["Zed.png", "Clip 10.mp4", "lobby poster.png", "Clip 2.mp4"]]]) {
      p.set("find-show", show);
      expect(p.shown(), show).toEqual(expected);
    }
    p.set("find-q", "CLIP 2", "input"); // every word, any case
    expect([p.count(), p.shown()]).toEqual(["Media (1 of 4)", ["Clip 2.mp4"]]);
    p.set("find-show", "image");
    expect([p.count(), p.shown()]).toEqual(["Media (0 of 4)", []]);
  });

  it("a hidden card is unticked; Select all and the counts take only what is shown", async () => {
    const p = await library(FILES, {});
    expect([p.bulk.disabled, p.add.disabled, p.all.textContent]).toEqual([true, true, "Select all"]);
    p.tick("Zed.png", "lobby poster.png");
    expect([p.bulk.disabled, p.bulk.textContent, p.picked.textContent]).toEqual([false, "Delete selected (2)", "2 files selected"]);
    expect(p.bulk.dataset.confirm).toBe("Delete Zed.png and lobby poster.png? They are removed from every playlist that uses them.");
    expect([p.add.disabled, p.add.textContent]).toEqual([true, "Add to playlist (2)"]); // no playlist picked yet
    p.set("add-to", "7");
    expect(p.add.disabled).toBe(false);

    p.set("find-q", "lobby", "input");
    expect([p.count(), p.bulk.textContent, p.add.textContent]).toEqual(["Media (1 of 4)", "Delete selected (1)", "Add to playlist (1)"]);
    expect(p.bulk.dataset.confirm).toBe("Delete lobby poster.png? It is removed from every playlist that uses it.");
    p.set("find-q", "", "input");
    expect(p.bulk.textContent).toBe("Delete selected (1)"); // Zed.png came back unticked

    p.set("find-show", "video");
    p.all.fire("click");
    expect([p.bulk.textContent, p.all.textContent]).toEqual(["Delete selected (2)", "Select none"]);
    expect(p.bulk.dataset.confirm).toBe("Delete Clip 10.mp4 and Clip 2.mp4? They are removed from every playlist that uses them.");
    p.set("find-show", "");
    p.all.fire("click"); // tops up to data-max (3) from the top of what is shown
    expect(p.bulk.dataset.confirm).toBe("Delete Zed.png, Clip 10.mp4 and Clip 2.mp4? They are removed from every playlist that uses them.");
    p.tick(...FILES.map(([name]) => name));
    expect([p.bulk.disabled, p.bulk.textContent, p.add.disabled, p.add.textContent]).toEqual([true, "Delete at most 3", true, "Add at most 3"]);
    expect(p.bulk.dataset.confirm).toBe("Delete these 4 files? They are removed from every playlist that uses them.");
  });

  it("the view is kept for the tab and put back after a reload", async () => {
    const store = {};
    let p = await library(FILES, store);
    p.set("find-sort", "name");
    p.set("find-q", "clip", "input");
    vi.resetModules();
    p = await library(FILES, store);
    expect([p.ids["find-q"].value, p.ids["find-sort"].value, p.count(), p.shown()]).toEqual(["clip", "name", "Media (2 of 4)", ["Clip 2.mp4", "Clip 10.mp4"]]);
    vi.resetModules();
    p = await library(FILES, null); // storage switched off: the page still works
    p.set("find-q", "zed", "input");
    expect(p.count()).toBe("Media (1 of 4)");
  });
});

describe("upload.js", () => {
  // Uploads `files` (one small picture) through stand-in requests; returns the requests sent
  // ([method, url, body]) and the queue rows' labels.
  async function upload(to, files = [new File([new Uint8Array(10)], "a.png")]) {
    const sent = [];
    const labels = [];
    vi.stubGlobal("XMLHttpRequest", class {
      upload = {};
      open(method, url) { Object.assign(this, { method, url }); }
      setRequestHeader() {}
      send(body) {
        sent.push([this.method, this.url, body]);
        const reply = this.url.endsWith("/init") ? { upload_id: 5, part_size: 8 * 1024 * 1024, received: 0 } : { ok: true };
        Object.assign(this, { status: 200, responseURL: this.url, responseText: JSON.stringify(reply) });
        setTimeout(() => this.onload());
      }
    });
    vi.stubGlobal("Image", class { set src(v) { setTimeout(() => this.onerror()); } }); // no metadata: nulls
    const button = el();
    const form = el({ dataset: { init: "/library/upload/init" }, querySelector: () => button });
    const ids = {
      "upload-form": form, "file-input": el({ files }),
      "upload-queue": el({ appendChild(li) { labels.push(li.kids[0].textContent); } }), "upload-status": el(), ...(to ? { "upload-to": to } : {}),
    };
    const reload = vi.fn();
    vi.stubGlobal("window", { addEventListener() {}, location: { reload } });
    vi.stubGlobal("document", { addEventListener() {}, getElementById: (id) => ids[id] || null, querySelector: () => null, createElement: () => el({ kids: [], appendChild(c) { this.kids.push(c); } }) });
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => {};
    try {
      await import("../public/upload.js");
      form.fire("submit");
      if (to) to.value = "3"; // changed while the batch is in flight
      await vi.waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 5000 });
    } finally {
      delete URL.createObjectURL;
      delete URL.revokeObjectURL;
    }
    return { sent, labels };
  }
  const complete = ({ sent }) => sent.find(([method, url]) => method === "POST" && url === "/library/upload/5/complete")[2];

  it("sends the playlist picked when the batch started; a page with no Add to sends {}", async () => {
    expect(complete(await upload(el({ value: "none" })))).toBe('{"playlist":"none"}');
    vi.resetModules();
    expect(complete(await upload(el({ value: "" })))).toBe('{"playlist":""}');
    vi.resetModules();
    expect(complete(await upload(null))).toBe("{}");
  });

  it("an animated GIF goes up with its running time, its frames' delays added up", async () => {
    // a Graphic Control Extension: 21 F9 04, flags, the delay in hundredths of a second, two more
    const gce = (delay) => [0x21, 0xf9, 0x04, 0x00, delay & 255, delay >> 8, 0x00, 0x00];
    const gif = (name, ...delays) => new File([new Uint8Array([0x47, 0x49, 0x46, ...delays.flatMap(gce)])], name);
    const { sent } = await upload(null, [gif("anim.gif", 5, 0, 300), gif("still.gif", 50)]); // 0 plays as 10
    const inits = sent.filter(([, url]) => url.endsWith("/init")).map(([, , body]) => JSON.parse(body));
    expect(inits.map((b) => [b.name, b.animated, b.duration_seconds])).toEqual([["anim.gif", true, 3.15], ["still.gif", false, null]]);
  });

  it("the queue writes a file's size the way the Library does", async () => {
    const { labels } = await upload(null, [999, 1000, 963584, 3984589].map((n, i) => new File([new Uint8Array(n)], `f${i}.png`)));
    expect(labels).toEqual(["f0.png (999 B)", "f1.png (1.0 KB)", "f2.png (941 KB)", "f3.png (3.8 MB)"]);
  });
});

// --------------------------------------------------------------------------- a page of parts ---

// The previews and the viewer need more of a page: parts in a tree, each matching the selectors
// in `is` (and its tag, and [hidden] while hidden), with text, focus and listeners.
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
  return p;
}

// The viewer's <dialog>: media.js build()'s markup, read into parts.
function dialogPart() {
  const d = part("dialog", [], { open: false });
  d.showModal = () => { d.open = true; };
  d.close = () => { d.open = false; d.fire("close"); };
  Object.defineProperty(d, "innerHTML", {
    get: () => d.markup,
    set(html) {
      d.markup = html;
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

// An editor's Library of `files` ([name, kind ("img" | "video"), meta]) with media.js loaded:
// the grid's form with its bar and a card per file (tick box, preview, Delete), Find. `fetch`
// answers the script's requests; `make` makes the elements it creates, by tag (canvas, video).
async function loadPage(files, { fetch = async () => ({ ok: true, status: 200 }), make = {} } = {}) {
  const body = part("body");
  const docOn = {};
  doc = {
    body, activeElement: body,
    addEventListener(type, fn) { (docOn[type] ||= []).push(fn); },
    fire(type, e) { for (const fn of docOn[type] || []) fn({ preventDefault() {}, ...e }); },
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => (make[tag] ? make[tag]() : tag === "dialog" ? dialogPart() : part(tag, [], { pause() {}, load() {} })),
    createTextNode: (text) => part("#text", [], { text }),
  };
  body.appendChild(part("meta", ['meta[name="csrf-token"]'], { content: "tok" }));
  const form = body.appendChild(part("form", [], { action: "/library/delete", dataset: { max: "500" } }));
  const bar = {};
  for (const [k, sel] of [["bulk", "[data-delete-selected]"], ["all", "[data-select-all]"], ["add", "[data-add-selected]"], ["picked", "[data-picked]"]]) bar[k] = form.appendChild(part("span", [sel]));
  const grid = form.appendChild(part("ul", [".media-grid", "[data-thumb-put]"]));
  const cards = files.map(([name, kind, meta], i) => {
    const id = String(i + 1);
    const href = `/api/media/f${id}_${name}`;
    const card = grid.appendChild(part("li", [".media-card"], { dataset: { name, kind: kind === "img" ? "image" : "video", use: "none", size: "1000", length: "0" } }));
    const box = card.appendChild(part("input", ['input[name="media_id"]'], { type: "checkbox", value: id, checked: false }));
    const link = card.appendChild(part("a", [".media-thumb", "a[data-view]"], { href, pathname: href, attrs: { href }, dataset: { kind, name, meta, page: `/library/${id}` } }));
    const img = link.appendChild(part("img", ["img[data-thumb]"], { dataset: { thumb: id }, src: `/library/${id}/thumb?v=0`, complete: false, naturalWidth: 0, naturalHeight: 0 }));
    card.appendChild(part("button", ['button[name="one"]'], { value: id, form, dataset: { confirm: `Delete ${name}? It is removed from every playlist that uses it.` } }));
    return { card, box, link, img };
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
  vi.stubGlobal("location", { reload: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(fetch));
  await import("../public/media.js");
  return { form, bar, grid, cards, ids, fetch: globalThis.fetch, confirm: globalThis.confirm, reload: globalThis.location.reload };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const OK = { ok: true, status: 200 };
// A canvas whose pixels are as bright as `bright()` says (0..255), and whose JPEG is a few bytes.
const canvasOf = (bright = () => 128) => () => part("canvas", [], {
  getContext: () => ({ fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4).fill(bright()) }) }),
  toBlob: (cb) => cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" })),
});

describe("media.js previews", () => {
  // Pictures larger than a preview, all waiting at once; `replies` answers their PUTs in turn (an
  // Error: no reply at all). Returns how many PUTs went out before the queue went quiet.
  async function stores(n, replies) {
    vi.resetModules();
    const p = await loadPage(Array.from({ length: n }, (_, i) => [`p${i}.png`, "img", ""]), {
      make: { canvas: canvasOf() },
      fetch: async () => { const r = replies.shift() || OK; if (r instanceof Error) throw r; return r; },
    });
    for (const { img } of p.cards) Object.assign(img, { naturalWidth: 1920, naturalHeight: 1080 });
    for (const { img } of p.cards) doc.fire("load", { target: img });
    for (let i = 0; i < 5; i++) await tick();
    return p.fetch.mock.calls;
  }

  it("a picture larger than a preview is drawn small and stored with PUT and the token; a stored preview is left alone", async () => {
    const p = await loadPage([["stored.png", "img", ""], ["big.png", "img", ""]], { make: { canvas: canvasOf() } });
    Object.assign(p.cards[0].img, { naturalWidth: 640, naturalHeight: 360 });
    Object.assign(p.cards[1].img, { naturalWidth: 1920, naturalHeight: 1080 });
    for (const { img } of p.cards) doc.fire("load", { target: img });
    await vi.waitFor(() => expect(p.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = p.fetch.mock.calls[0];
    expect([url, init.method, init.redirect, init.headers]).toEqual(["/library/2/thumb", "PUT", "manual", { "X-CSRF-Token": "tok", "Content-Type": "image/jpeg" }]);
  });

  it("a store that failed costs its own tile; a refusal, or three failures in a row, stops the rest", async () => {
    const ERR = { ok: false, status: 500 };
    expect((await stores(3, [{ ok: false, status: 404 }])).length).toBe(3); // a file deleted meanwhile
    expect((await stores(3, [new TypeError("Failed to fetch")])).length).toBe(3); // a dropped connection
    expect((await stores(3, [{ ok: false, status: 403 }])).length).toBe(1); // a stale token
    expect((await stores(3, [{ ok: false, status: 0, type: "opaqueredirect" }])).length).toBe(1); // signed out
    expect((await stores(5, [ERR, new TypeError("Failed to fetch"), ERR])).length).toBe(3); // an outage
    expect((await stores(6, [ERR, ERR, OK, ERR, ERR, OK])).length).toBe(6); // a stored one starts the count again
  });

  it("a short clip whose first frame is black tries its middle", async () => {
    const seeks = [];
    const video = () => {
      const v = part("video", [], { duration: 4, videoWidth: 1280, videoHeight: 720, pause() {}, load() {}, play: () => Promise.resolve() });
      Object.defineProperty(v, "src", { get: () => v.url, set: (url) => { v.url = url; setTimeout(() => v.onloadeddata()); } });
      Object.defineProperty(v, "currentTime", { get: () => seeks.at(-1) ?? 0, set: (t) => { seeks.push(t); setTimeout(() => v.onseeked()); } });
      return v;
    };
    let frames = 0;
    URL.createObjectURL = () => "blob:made";
    try {
      const p = await loadPage([["short.mp4", "video", ""]], { make: { video, canvas: canvasOf(() => (frames++ ? 200 : 0)) } });
      const { img, link } = p.cards[0];
      doc.fire("error", { target: img }); // no preview yet
      expect(link.classList.contains("is-making")).toBe(true);
      await vi.waitFor(() => expect(img.src).toBe("blob:made"));
      expect(seeks).toEqual([1, 2]); // a quarter of the way in, then the middle
      expect([p.fetch.mock.calls.length, link.classList.contains("is-making")]).toEqual([1, false]);
    } finally {
      delete URL.createObjectURL;
    }
  });
});

describe("media.js viewer", () => {
  const FILES3 = [["a.mp4", "video", "12 MB · 320×240 · 2.0 s · uploaded 2026-11-17 06:34 UTC"], ["b.png", "img", "900 B"], ["c.png", "img", "1.0 KB"]];
  // Opens the viewer on the i-th file, as a click on its preview does.
  const open = (p, i) => { p.cards[i].link.focus(); doc.fire("click", { target: p.cards[i].link, button: 0 }); };
  const viewer = () => {
    const d = doc.body.querySelector("dialog");
    const q = (sel) => d.querySelector(sel);
    return { d, name: q(".viewer-name"), stage: q(".viewer-stage"), meta: q(".viewer-meta"), close: q("[data-close]"), next: q('[data-step="1"]'), del: q("[data-delete]") };
  };

  it("names the file shown for a screen reader, keeps each fact on one line, and gives the focus back to the file last shown", async () => {
    const p = await loadPage(FILES3);
    open(p, 0);
    const v = viewer();
    expect([v.d.open, v.d.attrs["aria-labelledby"], v.name.textContent]).toEqual([true, "viewer-name", "a.mp4"]);
    expect(v.d.markup).toContain('<span class="viewer-name" id="viewer-name" aria-live="polite"></span>');
    const video = v.stage.children[0];
    expect([video.tagName, video.attrs["aria-label"]]).toEqual(["VIDEO", "a.mp4"]);
    expect(v.meta.children.filter((c) => c.tagName === "SPAN").map((c) => [c.className, c.textContent])).toEqual(
      [["nowrap", "12 MB"], ["nowrap", "320×240"], ["nowrap", "2.0 s"], ["nowrap", "uploaded 2026-11-17 06:34 UTC"]]);
    expect(v.meta.textContent).toBe(FILES3[0][2]);
    v.d.fire("click", { target: v.next });
    expect([v.name.textContent, v.stage.children[0].alt]).toEqual(["b.png", "b.png"]);
    v.d.fire("click", { target: v.close });
    expect(v.d.open).toBe(false);
    expect(doc.activeElement).toBe(p.cards[1].link);
  });

  it("a file that will not show: a note while the server has it, a reload once it is gone or signed out; the arrows go on", async () => {
    const replies = [];
    const p = await loadPage(FILES3, { fetch: async () => { const r = replies.shift(); if (r instanceof Error) throw r; return r; } });
    open(p, 0);
    const v = viewer();
    replies.push(OK);
    v.stage.children[0].onerror();
    await vi.waitFor(() => expect(v.stage.children[0].className).toBe("viewer-note"));
    expect(p.fetch).toHaveBeenLastCalledWith("/api/media/f1_a.mp4", { method: "HEAD", cache: "no-store" });
    const note = v.stage.children[0];
    expect(note.textContent).toBe("Cannot show this file here. Open the file itself");
    // the focus on the note's link: a step hands it to Close, inside the viewer, where the arrows work
    const own = note.querySelector("a");
    own.focus();
    v.d.fire("keydown", { key: "ArrowRight", target: own });
    expect(v.name.textContent).toBe("b.png");
    expect(doc.activeElement).toBe(v.close);

    replies.push(new TypeError("Failed to fetch")); // no answer: say what is known
    v.stage.children[0].onerror();
    await vi.waitFor(() => expect(v.stage.children[0].className).toBe("viewer-note"));
    expect(p.reload).not.toHaveBeenCalled();
    v.d.fire("keydown", { key: "ArrowRight", target: v.close });
    replies.push({ ok: false, status: 404 });
    v.stage.children[0].onerror();
    await vi.waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1));
    expect(v.stage.children[0].tagName).toBe("IMG");
  });

  it("Delete takes the file off the page from the viewer and shows the next one, until none is left", async () => {
    const p = await loadPage(FILES3, { fetch: async () => ({ ok: true, status: 200, url: "http://piplayer.test/library" }) });
    p.cards[1].box.checked = true;
    p.form.fire("change");
    expect(p.bar.bulk.textContent).toBe("Delete selected (1)");
    open(p, 1);
    const v = viewer();
    expect(v.del.hidden).toBe(false);
    v.d.fire("click", { target: v.del });
    expect(p.confirm).toHaveBeenCalledWith("Delete b.png? It is removed from every playlist that uses it.");
    const [url, init] = p.fetch.mock.calls[0];
    expect([url, init.method, String(init.body), init.headers]).toEqual(["/library/delete", "POST", "one=2", { "X-CSRF-Token": "tok" }]);
    await vi.waitFor(() => expect(v.name.textContent).toBe("c.png"));
    expect(p.grid.children.map((c) => c.dataset.name)).toEqual(["a.mp4", "c.png"]);
    expect([p.ids["media-count"].textContent, p.bar.bulk.textContent]).toEqual(["Media (2)", "Delete selected"]);
    // pressed twice before the answer: one delete, no reload, the one before it next
    v.d.fire("click", { target: v.del });
    v.d.fire("click", { target: v.del });
    await vi.waitFor(() => expect(v.name.textContent).toBe("a.mp4"));
    for (let i = 0; i < 3; i++) await tick();
    expect([p.fetch.mock.calls.length, p.reload.mock.calls.length, v.name.textContent]).toEqual([3, 0, "a.mp4"]);
    v.d.fire("click", { target: v.del });
    await vi.waitFor(() => expect(v.d.open).toBe(false));
    expect([p.grid.children.length, p.ids["media-count"].textContent]).toEqual([0, "Media (0)"]);
  });

  it("Delete: no question answered, nothing sent; anything but the Library coming back reloads the page", async () => {
    const p = await loadPage(FILES3, { fetch: async () => ({ ok: true, status: 200, url: "http://piplayer.test/login?expired=1" }) });
    open(p, 0);
    const v = viewer();
    p.confirm.mockReturnValueOnce(false);
    v.d.fire("click", { target: v.del });
    expect(p.fetch).not.toHaveBeenCalled();
    v.d.fire("click", { target: v.del });
    await vi.waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1));
    expect(p.grid.children.length).toBe(3);
  });
});

describe("app.js", () => {
  // app.js's listeners on a stand-in document, with confirm answering no.
  async function app() {
    const on = {};
    vi.stubGlobal("window", {});
    vi.stubGlobal("confirm", vi.fn(() => false));
    vi.stubGlobal("document", {
      readyState: "complete", querySelector: () => null, getElementById: () => null,
      addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
    });
    await import("../public/app.js");
    return (type, e) => { for (const fn of on[type] || []) fn(e); };
  }
  const submit = (form, submitter) => ({ target: form, submitter, stopped: false, preventDefault() { this.stopped = true; } });

  it("a destructive submit asks the form's question, or the pressed button's, also where the browser does not say which", async () => {
    const fire = await app();
    let e = submit({ dataset: { confirm: "Delete the group?" } }); // one question for the whole form
    fire("submit", e);
    expect([confirm.mock.calls.at(-1)[0], e.stopped]).toEqual(["Delete the group?", true]);
    // the Library's grid: the question is on the button pressed
    const form = { dataset: {} };
    const button = { form, dataset: { confirm: "Delete a.mp4? It is removed from every playlist that uses it." } };
    e = submit(form, button);
    fire("submit", e);
    expect([confirm.mock.calls.at(-1)[0], e.stopped]).toEqual([button.dataset.confirm, true]);
    // no e.submitter (Safari before 15.4): the click on the way in says which button it was
    fire("click", { target: { closest: (sel) => (sel === 'button[type="submit"]' ? button : null) } });
    e = submit(form);
    fire("submit", e);
    expect([confirm.mock.calls.length, confirm.mock.calls.at(-1)[0], e.stopped]).toEqual([3, button.dataset.confirm, true]);
    e = submit({ dataset: {} }); // nothing to ask
    fire("submit", e);
    expect([confirm.mock.calls.length, e.stopped]).toEqual([3, false]);
  });
});
