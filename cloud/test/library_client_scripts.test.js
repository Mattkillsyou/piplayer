// The Library's scripts against a few stand-in elements (workerd has no DOM): media.js's Find /
// Show / Sort and its media bar (Delete selected, Add to playlist, Select all), and upload.js
// sending the upload box's "Add to" with the complete request.
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

describe("upload.js Add to", () => {
  // Uploads one small picture through stand-in requests; returns the complete request's body.
  async function upload(to) {
    const sent = [];
    vi.stubGlobal("XMLHttpRequest", class {
      upload = {};
      open(method, url) { Object.assign(this, { method, url }); }
      setRequestHeader() {}
      send(body) {
        sent.push([this.method, this.url, body]);
        const reply = this.url.endsWith("/init") ? { upload_id: 5, part_size: 1024, received: 0 } : { ok: true };
        Object.assign(this, { status: 200, responseURL: this.url, responseText: JSON.stringify(reply) });
        setTimeout(() => this.onload());
      }
    });
    vi.stubGlobal("Image", class { set src(v) { setTimeout(() => this.onerror()); } }); // no metadata: nulls
    const button = el();
    const form = el({ dataset: { init: "/library/upload/init" }, querySelector: () => button });
    const ids = {
      "upload-form": form, "file-input": el({ files: [new File([new Uint8Array(10)], "a.png")] }),
      "upload-queue": el({ appendChild() {} }), "upload-status": el(), ...(to ? { "upload-to": to } : {}),
    };
    const reload = vi.fn();
    vi.stubGlobal("window", { addEventListener() {}, location: { reload } });
    vi.stubGlobal("document", { addEventListener() {}, getElementById: (id) => ids[id] || null, querySelector: () => null, createElement: () => el({ appendChild() {} }) });
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => {};
    try {
      await import("../public/upload.js");
      form.fire("submit");
      if (to) to.value = "3"; // changed while the batch is in flight
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      delete URL.createObjectURL;
      delete URL.revokeObjectURL;
    }
    return sent.find(([method, url]) => method === "POST" && url === "/library/upload/5/complete")[2];
  }

  it("sends the playlist picked when the batch started; a page with no Add to sends {}", async () => {
    expect(await upload(el({ value: "none" }))).toBe('{"playlist":"none"}');
    vi.resetModules();
    expect(await upload(el({ value: "" }))).toBe('{"playlist":""}');
    vi.resetModules();
    expect(await upload(null)).toBe("{}");
  });
});
