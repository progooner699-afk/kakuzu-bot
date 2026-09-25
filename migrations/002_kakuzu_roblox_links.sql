-- 002_kakuzu_roblox_links.sql
-- Permanent GLOBAL Roblox link storage. One row per linked Discord user.
-- A Discord user links ONCE globally; every Kakuzu guild reads the same row
-- keyed ONLY by discord_user_id (never guild_id).
-- Supabase is the permanent source of truth; in-memory caches are derived from it.
-- Never DROP, TRUNCATE or DELETE existing rows on startup.

CREATE TABLE IF NOT EXISTS kakuzu_roblox_links (
    discord_user_id TEXT PRIMARY KEY,
    roblox_user_id TEXT NOT NULL,
    roblox_username TEXT NOT NULL,
    roblox_display_name TEXT,
    roblox_avatar_url TEXT,
    verified BOOLEAN NOT NULL DEFAULT TRUE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrade path for deployments that already ran the original 002 (which only
-- had discord_user_id / roblox_user_id / roblox_username / linked_at).
ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS roblox_display_name TEXT;
ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS roblox_avatar_url TEXT;
ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- One Roblox account may back at most one Discord link: reject (do not steal)
-- duplicate Roblox IDs at the database level. NULLs never collide here because
-- roblox_user_id is NOT NULL.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_kakuzu_roblox_links_roblox_user_id') THEN
        ALTER TABLE kakuzu_roblox_links
            ADD CONSTRAINT uq_kakuzu_roblox_links_roblox_user_id UNIQUE (roblox_user_id);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_roblox_links_roblox_user_id
    ON kakuzu_roblox_links (roblox_user_id);
