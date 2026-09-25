'use strict';

/*
 * 003_migrate_legacy_verification_links.sql — one-time, best-effort import of
 * pre-global per-guild verification.sqlite links is NOT possible inside
 * Supabase itself (those files live on the bot host's ephemeral filesystem,
 * not in Postgres). This migration therefore only guarantees the global table
 * shape for rows the bot writes going forward; the actual legacy import runs
 * in Node (scripts/migrate-legacy-roblox-links.js) where the sqlite files are
 * readable. Safe to re-run: additive only, never deletes old data.
 */

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
