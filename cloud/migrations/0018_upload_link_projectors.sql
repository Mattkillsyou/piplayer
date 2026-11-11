-- Which projectors an account's upload links list and may send to (src/pages/links.js
-- projectorsOf; Settings page, "Upload links" panel, "Projectors on upload links"): 1 = on every
-- upload link page of its account, 0 = left off them. Nothing else about the projector changes.
-- Every projector that exists stays on, as before.
ALTER TABLE devices ADD COLUMN in_upload_links INTEGER NOT NULL DEFAULT 1 CHECK (in_upload_links IN (0, 1));

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '18');
