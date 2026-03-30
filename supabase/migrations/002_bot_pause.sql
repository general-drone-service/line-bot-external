-- Bot pause table: tracks which users have bot auto-reply paused (e.g. after human handoff)
CREATE TABLE IF NOT EXISTS bot_pause (
  user_id TEXT PRIMARY KEY,
  paused_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for quick lookup
CREATE INDEX IF NOT EXISTS idx_bot_pause_until ON bot_pause (paused_until);

-- Auto-cleanup: remove expired rows (optional — can be run via pg_cron)
-- DELETE FROM bot_pause WHERE paused_until < now();
