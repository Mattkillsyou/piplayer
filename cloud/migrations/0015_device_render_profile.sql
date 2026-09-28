-- Per-device mpv render profile: NULL = mpv's defaults; "fast" = mpv's built-in fast profile (bilinear
-- scaling, no dithering), for a GPU that cannot draw 1080p at the default quality in time. Sent in the
-- manifest next to hwdec (migration 0014) and applied by the player at runtime.
ALTER TABLE devices ADD COLUMN mpv_profile TEXT;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '15');
