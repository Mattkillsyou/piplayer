// The vendored streaming SHA-256 (public/sha256.js) must agree with WebCrypto byte for byte,
// for every padding boundary and when fed in odd-sized chunks.
import { describe, expect, it } from "vitest";
import "../public/sha256.js";

const sha256 = globalThis.sha256;
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);
const webcrypto = async (data) => hex(await crypto.subtle.digest("SHA-256", data));

describe("public/sha256.js", () => {
  it("matches crypto.subtle.digest for 0, 1, 55, 56, 64, 65, 1000 and 1e6 byte inputs", async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 1e6]) {
      const data = pattern(n);
      expect(sha256.create().update(data).digest(), `${n} bytes`).toBe(await webcrypto(data));
    }
  });

  it("known answer: 'abc'", () => {
    expect(sha256.create().update(new TextEncoder().encode("abc")).digest())
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("chunked updates equal one whole update (slice sizes crossing every 64-byte boundary)", async () => {
    const data = pattern(100003);
    const h = sha256.create();
    const sizes = [1, 63, 64, 65, 1000, 7, 33, 8191, 2];
    for (let p = 0, k = 0; p < data.length; k++) {
      const s = sizes[k % sizes.length];
      h.update(data.subarray(p, p + s));
      p += s;
    }
    expect(h.digest()).toBe(await webcrypto(data));
  });

  it("refuses updates after digest", () => {
    const h = sha256.create();
    h.digest();
    expect(() => h.update(new Uint8Array(1))).toThrow();
    expect(() => h.digest()).toThrow();
  });
});
