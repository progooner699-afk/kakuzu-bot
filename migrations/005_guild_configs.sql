-- 005_guild_configs.sql
-- Per-guild RAID ADMIN (staff) roles for STRICT, guild-isolated raid-action
-- authorization (close / edit / end raid). Written by /adminsetup, read by
-- handlers/raidAdminRoles.js (isRaidAdmin).
--
-- guild_id          : Discord guild (server) snowflake — the ONLY key. A row
--                     in guild A never affects guild B.
-- raid_admin_roles  : TEXT[] of role IDs that grant raid-admin rights IN THAT
--                     guild. Default '{}' = nobody besides requesters and
--                     Discord Administrators.
-- updated_at        : last /adminsetup save.
--
-- ADDITIVE ONLY: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- No DROP, no TRUNCATE, touches no existing table.

CREATE TABLE IF NOT EXISTS guild_configs (
    guild_id TEXT PRIMARY KEY,
    raid_admin_roles TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS raid_admin_roles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
