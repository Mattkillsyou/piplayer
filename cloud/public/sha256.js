// Streaming SHA-256 (FIPS 180-4) for upload.js: WebCrypto's digest() needs the whole file
// in memory, this hashes 8 MiB slices as they are read. Exposed as globalThis.sha256 so the
// same file runs in the browser and in the vitest checks against crypto.subtle.
//   var h = sha256.create(); h.update(uint8array); ...; var hex = h.digest();
(function (root) {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function Hasher() {
    this.h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Int32Array(64);
    this.block = new Uint8Array(64);   // pending bytes (< 64)
    this.pending = 0;
    this.lengthLo = 0;                 // total bytes, split so > 4 GiB inputs are exact
    this.lengthHi = 0;
    this.done = false;
  }

  Hasher.prototype._compress = function (bytes, off) {
    var w = this.w, h = this.h, i, t1, t2, s0, s1;
    for (i = 0; i < 16; i++) {
      w[i] = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
      off += 4;
    }
    for (i = 16; i < 64; i++) {
      t1 = w[i - 15];
      s0 = ((t1 >>> 7) | (t1 << 25)) ^ ((t1 >>> 18) | (t1 << 14)) ^ (t1 >>> 3);
      t2 = w[i - 2];
      s1 = ((t2 >>> 17) | (t2 << 15)) ^ ((t2 >>> 19) | (t2 << 13)) ^ (t2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  };

  // Feed a Uint8Array (any length). Returns this for chaining.
  Hasher.prototype.update = function (data) {
    if (this.done) throw new Error('sha256: update after digest');
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
    var n = data.length, pos = 0;
    this.lengthLo += n;
    if (this.lengthLo >= 0x100000000) { this.lengthHi += Math.floor(this.lengthLo / 0x100000000); this.lengthLo %= 0x100000000; }
    if (this.pending) {
      var take = Math.min(64 - this.pending, n);
      this.block.set(data.subarray(0, take), this.pending);
      this.pending += take;
      pos = take;
      if (this.pending < 64) return this;
      this._compress(this.block, 0);
      this.pending = 0;
    }
    while (pos + 64 <= n) { this._compress(data, pos); pos += 64; }
    if (pos < n) { this.block.set(data.subarray(pos)); this.pending = n - pos; }
    return this;
  };

  // Lower-case hex digest. The hasher cannot be updated afterwards.
  Hasher.prototype.digest = function () {
    if (this.done) throw new Error('sha256: digest called twice');
    this.done = true;
    var block = this.block, pending = this.pending;
    block[pending++] = 0x80;
    if (pending > 56) {
      while (pending < 64) block[pending++] = 0;
      this._compress(block, 0);
      pending = 0;
    }
    while (pending < 56) block[pending++] = 0;
    // 64-bit big-endian bit length = bytes * 8
    var bitsHi = (this.lengthHi * 8 + Math.floor(this.lengthLo / 0x20000000)) >>> 0;
    var bitsLo = (this.lengthLo * 8) >>> 0;
    block[56] = bitsHi >>> 24; block[57] = (bitsHi >>> 16) & 255; block[58] = (bitsHi >>> 8) & 255; block[59] = bitsHi & 255;
    block[60] = bitsLo >>> 24; block[61] = (bitsLo >>> 16) & 255; block[62] = (bitsLo >>> 8) & 255; block[63] = bitsLo & 255;
    this._compress(block, 0);
    var out = '';
    for (var i = 0; i < 8; i++) out += ('00000000' + (this.h[i] >>> 0).toString(16)).slice(-8);
    return out;
  };

  root.sha256 = { create: function () { return new Hasher(); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
