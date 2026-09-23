-- What mpv is actually doing with the file on screen, reported on every sync: the decoder in
-- use ("software" when none) and how fast the picture is really moving (1.0 = real speed,
-- measured from time-pos against the clock). A Pi 4 decoding 1080p H.264 in software plays it
-- in slow motion, and until now nothing on the Devices page said so.
-- NULL = never reported (a player older than this release), and a sync without the params keeps the
-- last known values, like player_version.
ALTER TABLE devices ADD COLUMN decode_mode TEXT;
ALTER TABLE devices ADD COLUMN play_rate REAL;   -- 1.0 = real speed

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '12');
