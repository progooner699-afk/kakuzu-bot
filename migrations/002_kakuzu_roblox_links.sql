-- 002_kakuzu_roblox_links.sql
-- Permanent Roblox link storage.  One row per linked Discord user.
-- Supabase is the permanent source of truth; in-memory caches are derived from it.
-- Never DROP, TRUNCATE or DELETE existing rows on startup.

CREATE TABLE IF NOT EXISTS kakuzu_roblox_links (
    discord_user_id TEXT PRIMARY KEY,
    roblox_user_id TEXT NOT NULL,
    roblox_username TEXT NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_roblox_links_roblox_user_id
    ON kakuzu_roblox_links (roblox_user_id);
