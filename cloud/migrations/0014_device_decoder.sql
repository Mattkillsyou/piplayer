-- Per-device decoder choice and a comparable drop count.
-- mpv_hwdec: NULL = the player's own default; otherwise one of the values the player accepts (player/
-- player/daemon.py HWDEC_CHOICES), sent in the manifest and applied over mpv's IPC socket. It lets the
-- decoder be tried and changed on a projector without shipping code for each attempt.
-- drop_rate: frames mpv dropped per minute over the last sync interval. dropped_frames is mpv's own
-- counter, which starts again with every loop of the file, so it cannot compare two settings.
ALTER TABLE devices ADD COLUMN mpv_hwdec TEXT;
ALTER TABLE devices ADD COLUMN drop_rate REAL;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '14');
