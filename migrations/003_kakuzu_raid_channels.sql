-- 003_kakuzu_raid_channels.sql
-- Permanent raid-result channel per guild.  Only the result channel is stored here.
-- No raid-alert, raid-log, verification, backup-panel or other channel settings.
-- The /setchannel command writes here; raid result posting reads from here.

CREATE TABLE IF NOT EXISTS kakuzu_raid_channels (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
