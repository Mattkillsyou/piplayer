// Devices track fixes of the console-ui release (verify run): the decode badge of a projector that
// is not playing, a now-playing file in Recently deleted, the empty playlist's links for a viewer
// or another account's projector, the card a New token or a tunnel lands on, the links to a
// projector's card and its playlist and file, and pausing a projector's alerts.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { device, roles } from "./pages_common.js";

let r;
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

beforeAll(async () => {
  r = await roles();
});

describe("decode badge", () => {
  it("says playing only for a projector that plays; an offline or paused one shows its last measured speed", async () => {
    const dev = await device("slow-1", "Slow", { last_seen_at: now(), player_status: "playing", decode_mode: "software", play_rate: 0.62 });
    const badge = async () => /software decoding[^<]*/.exec(await (await r.editor.get("/devices")).text())[0];
    expect(await badge()).toBe("software decoding · playing at 0.62x speed");
    await query("UPDATE devices SET player_status = 'paused' WHERE id = ?", dev.id);
    expect(await badge()).toBe("software decoding · last played at 0.62x speed");
    await query("UPDATE devices SET player_status = 'playing', last_seen_at = datetime('now', '-7 days') WHERE id = ?", dev.id);
    expect(await badge()).toBe("software decoding · last played at 0.62x speed");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});
