// app.js on the Devices page after a change made on a projector's card (devices.js cardUrl): the
// notice drawn at the top of the page moves into the card the page lands on (workerd has no DOM:
// a few stand-in elements).
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// /devices<hash> with a notice and one card, #device-7 (`cls` its class), whose first column holds
// its screenshot.
async function devicesPage(hash, cls = "device-row") {
  const note = { id: "notice" };
  const screen = { id: "screen" };
  const column = {
    children: [screen],
    get firstChild() { return this.children[0] || null; },
    insertBefore(node, ref) { this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, node); },
  };
  const card = { classList: { contains: (c) => c === cls }, firstElementChild: column, scrolled: 0, scrollIntoView() { this.scrolled += 1; } };
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { hash });
  vi.stubGlobal("document", {
    readyState: "complete", addEventListener() {},
    querySelector: (sel) => (sel === 'main > .alert[role="alert"]' ? note : null),
    getElementById: (id) => (id === "device-7" ? card : null),
  });
  await import("../public/app.js");
  return { note, screen, column, card };
}

describe("app.js: the notice of a card action", () => {
  it("moves to the top of the landed card's first column, the card in view", async () => {
    const p = await devicesPage("#device-7");
    expect(p.column.children).toEqual([p.note, p.screen]);
    expect(p.card.scrolled).toBe(1);
  });

  it("stays at the top of the page with no hash, an unknown card, or a target that is not a projector's card", async () => {
    for (const [hash, cls] of [["", "device-row"], ["#device-9", "device-row"], ["#device-7", "panel"]]) {
      const p = await devicesPage(hash, cls);
      expect([p.column.children, p.card.scrolled], `${hash} ${cls}`).toEqual([[p.screen], 0]);
      vi.resetModules();
    }
  });
});
