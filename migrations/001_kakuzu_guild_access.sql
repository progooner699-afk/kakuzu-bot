'use strict';

/**
 * 001_kakuzu_guild_access.sql — permanent premium server-access store.
 *
 * SAFE MIGRATION CONTRACT:
 *  - CREATE TABLE IF NOT EXISTS only.
 *  - NEVER DROP / TRUNCATE / recreate / delete existing rows.
 *  - Rerunning this file is always a no-op for existing data.
 *
 * Run in Supabase SQL editor (or psql) once. The bot also ensures these
 * tables idempotently at startup via handlers/guildAccess.js, so a missed
 * manual run never breaks the guard (Supabase remains authoritative).
 */

CREATE TABLE IF NOT EXISTS kakuzu_guilds (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT,
    owner_id TEXT,
    bot_present BOOLEAN NOT NULL DEFAULT TRUE,

    access_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (access_status IN ('pending', 'granted', 'revoked')),

    onboarding_channel_id TEXT,
    onboarding_message_id TEXT,
    onboarding_created_at TIMESTAMPTZ,

    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,

    granted_by TEXT,
    granted_at TIMESTAMPTZ,

    revoked_by TEXT,
    revoked_at TIMESTAMPTZ,

    owner_dm_status TEXT,
    owner_dm_sent_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kakuzu_access_events (
    id BIGSERIAL PRIMARY KEY,
    guild_id TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('joined', 'granted', 'revoked', 'left')),
    performed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kakuzu_guilds_access_status ON kakuzu_guilds (access_status);
CREATE INDEX IF NOT EXISTS idx_kakuzu_access_events_guild_id ON kakuzu_access_events (guild_id);
