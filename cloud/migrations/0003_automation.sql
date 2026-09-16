-- Automation features A-G (one file, additive: append new ALTERs / CREATE TABLEs at the end,
-- never edit 0001/0002; keep the schema_version bump as the last statement).
-- A (auto-assign on enrollment): settings keys enroll_group_id / enroll_playlist_id live in the
-- existing `settings` table, no columns needed.
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
