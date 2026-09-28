-- How the picture is paced, reported on every sync next to decode_mode: what the screen runs at,
-- what the file runs at, and how many frames mpv could not place. A 30 fps film on a 50 Hz screen
-- plays at the right speed and still looks wrong, which nothing on the Devices page could show.
-- NULL = never reported (a player older than this release); a sync without them keeps the last values.
ALTER TABLE devices ADD COLUMN display_fps REAL;
ALTER TABLE devices ADD COLUMN video_fps REAL;
ALTER TABLE devices ADD COLUMN dropped_frames INTEGER;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '13');
