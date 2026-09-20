-- 004_kakuzu_raids.sql
-- Permanent raid storage: every created raid is recorded here with its sequential
-- display number (R-000001, R-000002, ...).  The next number is computed as
-- COALESCE(MAX(display_number),0)+1 per guild, so numbering continues correctly
-- after deployments, crashes and cache resets.  Supabase is the source of truth.
--
-- raid_id        : internal unique identifier (UUID-ish string).  Survives restarts.
-- display_number : sequential number per guild (1, 2, 3, ...).  Rendered as R-000001.
-- status         : PENDING | OPEN | FULL | CLOSED
-- outcome        : win | whooped | loss | noresult  (NULL = not yet ended)
--
-- This table does NOT modify or delete any existing ping-settings data.

CREATE TABLE IF NOT EXISTS kakuzu_raids (
    raid_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    display_number INTEGER NOT NULL,
    requester_id TEXT NOT NULL,
    target_game TEXT,
    place_id TEXT,
    server_id TEXT,
    enemy_clan_names TEXT,
    enemy_names TEXT,
    region TEXT,
    country_code TEXT,
    reason TEXT,
    helper_limit INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','OPEN','FULL','CLOSED')),
    outcome TEXT
        CHECK (outcome IS NULL OR outcome IN ('win','whooped','loss','noresult')),
    mvp_user_id TEXT,
    result_channel_id TEXT,
    raid_message_id TEXT,
    alert_channel_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_raids_guild_display
    ON kakuzu_raids (guild_id, display_number);

CREATE INDEX IF NOT EXISTS idx_raids_requester
    ON kakuzu_raids (requester_id);
