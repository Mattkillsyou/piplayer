// appendToPlaylist reads rows by the ids it is given, not by the size of the library: its UPDATE
// walked every file of the account and scanned the ids for each one (about 250,000 rows read to
// re-add 500 files in a 1,000-file library), a few such requests a day's D1 budget.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { appendToPlaylist } from "../src/pages/library.js";
import { query } from "./helpers.js";
import { playlist, roles } from "./pages_common.js";

let owner, files;

// env with a DB whose batch() keeps each statement's meta.rows_read in `reads`.
const counted = (reads) => ({
  ...env,
  DB: {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      const results = await env.DB.batch(statements);
      for (const r of results) reads.push(r.meta.rows_read);
      return results;
    },
  },
});

beforeAll(async () => {
  owner = (await roles()).ids.editor;
  // 1,000 files with random sha256s (the order of the owner's sha256 index is the order the
  // old plan walked them in)
  await query(`INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
    SELECT 'bulk_' || i || '.png', 'bulk ' || i || '.png', 'image', 1000, lower(hex(randomblob(32))), ? FROM n`, owner);
  files = (await query("SELECT id FROM media WHERE owner_id = ? ORDER BY id", owner)).map((r) => r.id);
});

describe("appendToPlaylist in a 1,000-file library", () => {
  it("re-adding 500 files already in the playlist reads rows by the ids, not files x ids", async () => {
    const pid = await playlist("Big");
    await query(`INSERT INTO playlist_items (playlist_id, media_id, position)
      SELECT ?1, value, key FROM json_each(?2)`, pid, JSON.stringify(files.slice(0, 500)));
    const reads = [];
    expect(await appendToPlaylist(counted(reads), pid, files.slice(0, 500), owner)).toEqual({ added: 0, already: 500 });
    expect(reads.length).toBe(3);
    expect(reads[1], `the UPDATE read ${reads[1]} rows`).toBeLessThan(5000);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(15000);
  });

  it("499 already in and one new: the new one lands last, the reads stay small", async () => {
    const pid = await playlist("Big two");
    await query(`INSERT INTO playlist_items (playlist_id, media_id, position)
      SELECT ?1, value, key FROM json_each(?2)`, pid, JSON.stringify(files.slice(0, 499)));
    const reads = [];
    expect(await appendToPlaylist(counted(reads), pid, files.slice(0, 500), owner)).toEqual({ added: 1, already: 499 });
    expect(reads[1], `the UPDATE read ${reads[1]} rows`).toBeLessThan(5000);
    const last = await query("SELECT media_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position DESC LIMIT 1", pid);
    expect(last).toEqual([{ media_id: files[499], position: 499 }]);
  });

  it("500 ids that are no files read next to nothing", async () => {
    const pid = await playlist("Big three");
    const reads = [];
    const nope = Array.from({ length: 500 }, (_, i) => 900000 + i);
    expect(await appendToPlaylist(counted(reads), pid, nope, owner)).toEqual({ added: 0, already: 0 });
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(5000);
  });
});
