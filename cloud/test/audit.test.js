// audit.pyJson: the Details column must read exactly like Python's json.dumps (web.py).
import { describe, expect, it } from "vitest";
import { pyJson } from "../src/audit.js";

describe("audit.pyJson", () => {
  it("uses Python's default separators", () => {
    expect(pyJson({ a: 1, b: "x", c: [1, 2] })).toBe('{"a": 1, "b": "x", "c": [1, 2]}');
    expect(pyJson({ command: "reboot", command_id: 2 })).toBe('{"command": "reboot", "command_id": 2}');
    expect(pyJson({ playlist_id: null, on: true, empty: {}, none: [] })).toBe('{"playlist_id": null, "on": true, "empty": {}, "none": []}');
  });

  it("escapes like ensure_ascii and drops undefined like JSON.stringify", () => {
    const bsu = "\\u"; // a literal backslash-u
    expect(pyJson({ name: 'Caf\xe9 "q" \\ \n' })).toBe(`{"name": "Caf${bsu}00e9 \\"q\\" \\\\ \\n"}`);
    expect(pyJson({ emoji: "\u{1F600}" })).toBe(`{"emoji": "${bsu}d83d${bsu}de00"}`);
    expect(pyJson({ a: undefined, b: 1 })).toBe('{"b": 1}');
  });
});
