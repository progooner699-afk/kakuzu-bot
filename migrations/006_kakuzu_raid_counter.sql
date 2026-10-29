-- 006_kakuzu_raid_counter.sql
-- Minimal per-guild raid counter persistence.
-- Only stores the numeric last_raid_id. No raid details, embeds, or other data.

CREATE TABLE IF NOT EXISTS kakuzu_raid_counter (
    guild_id TEXT PRIMARY KEY,
    last_raid_id INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
