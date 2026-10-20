'use strict';

/*
 * raidAdminRoles.js — per-guild RAID ADMIN (staff) role authorization.
 *
 * STORAGE: permanent source of truth is the Supabase PostgreSQL table
 * `guild_configs` (guild_id TEXT PK, raid_admin_roles TEXT[] DEFAULT '{}',
 * updated_at TIMESTAMPTZ), written by /adminsetup. The in-memory cache below
 * is only a performance layer: it is refreshed AFTER a successful database
 * read and NEVER on failure (a DB outage can never erase valid roles).
 *
 * STRICT PER-GUILD ISOLATION CONTRACT
 * ------------------------------------------------------------------
 * Every query is keyed by exactly ONE guild_id (the guild the interaction is
 * happening in) and role IDs are matched ONLY against `member.roles.cache` —
 * the roles the member holds in THAT guild. A user who is Admin/Staff in
 * guild A therefore gets NOTHING in guild B unless guild B has its own
 * guild_configs row listing roles the member also holds in guild B.
 * `isRaidAdmin` additionally refuses a member whose `member.guild.id`
 * differs from the guildId being authorized, so even a caller bug can never
 * leak staff access across servers.
 *
 * FAIL-CLOSED, ACK-SAFE READS
 * ------------------------------------------------------------------
 * Reads are bounded to READ_TIMEOUT_MS so the interaction guard in
 * events/interactionCreate.js always answers inside Discord's 3s ack window.
 * A failed/slow read falls back to the last CONFIRMED role list only while it
 * is within STALE_GRACE_MS; after that the answer is "not admin" (fail
 * CLOSED). Writes always rethrow a sanitized error — an admin must see a
 * truthful save failure, never a fake success.
 */

const { PermissionFlagsBits } = require('discord.js');
const supabaseDb = require('./supabaseDb');
const { sanitizeError } = require('./sharedPingDb');

const TABLE = 'guild_configs';
// Button-guard budget: must leave headroom inside Discord's 3s ack window.
const READ_TIMEOUT_MS = 1500;
// Saves always run behind deferReply() / deferUpdate(), so they get more room.
const WRITE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30 * 1000;         // fresh window — no DB round-trip
const STALE_GRACE_MS = 5 * 60 * 1000;   // outage fallback for confirmed data
const TABLE_INIT_RETRY_BACKOFF_MS = 60 * 1000;
// /adminsetup uses a RoleSelect capped at 10 roles.
const MAX_ROLES = 10;

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    guild_id TEXT PRIMARY KEY,
    raid_admin_roles TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

/** guildId -> { roles: string[], fetchedAt: number } — confirmed reads only. */
const roleCache = new Map();

// Idempotent DDL state (mirrors guildAccess.ensureAccessTables backoff):
// the read path KICKS init but never awaits it (cold DDL must not eat the
// ack budget); explicit writes await it with force.
const tableInit = { inFlight: null, ok: false, lastFailureAt: 0 };
let warnedUnconfigured = false;

/**
 * Coerces anything array-ish into a deduplicated list of non-empty strings.
 * @param {*} roleIds
 * @returns {string[]}
 */
function normalizeRoleIds(roleIds) {
    if (!Array.isArray(roleIds)) return [];
    const out = [];
    for (const raw of roleIds) {
        if (raw == null) continue;
        const id = String(raw).trim();
        if (!id) continue;
        if (!out.includes(id)) out.push(id);
    }
    return out;
}

/**
 * Fire-and-forget (or awaited for writes) idempotent table creation.
 * A failed init is memoised and retried at most once per minute.
 * @param {boolean} force — explicit user-initiated writes ignore the backoff.
 * @returns {Promise<void>}
 */
function kickTableInit(force = false) {
    if (tableInit.ok) return Promise.resolve();
    if (tableInit.inFlight) return tableInit.inFlight;
    if (!force && tableInit.lastFailureAt && (Date.now() - tableInit.lastFailureAt) < TABLE_INIT_RETRY_BACKOFF_MS) {
        return Promise.resolve();
    }
    if (!supabaseDb.isConfigured()) {
        if (!warnedUnconfigured) {
            warnedUnconfigured = true;
            console.warn('[raidAdminRoles] DATABASE_URL is not configured — raid admin roles read as "none" and /adminsetup saves will fail until it is set.');
        }
        return Promise.resolve();
    }
    tableInit.inFlight = supabaseDb.runQuery(CREATE_TABLE_SQL, [], 8000)
        .then(() => { tableInit.ok = true; })
        .catch((err) => {
            tableInit.ok = false;
            tableInit.lastFailureAt = Date.now();
            console.warn('[raidAdminRoles] table init FAILED (will retry in 60s):', sanitizeError(err));
        })
        .finally(() => { tableInit.inFlight = null; });
    return tableInit.inFlight;
}

/**
 * Reads the authorized raid-admin role IDs for ONE guild.
 * Never throws. Cache-first (30s), then one bounded SELECT; a failed read
 * returns the last confirmed roles only inside STALE_GRACE_MS, else [].
 * @param {string} guildId
 * @returns {Promise<string[]>}
 */
async function getRaidAdminRoles(guildId) {
    if (!guildId) return [];
    const cached = roleCache.get(guildId);
    const now = Date.now();
    if (cached && now - cached.fetchedAt <= CACHE_TTL_MS) return cached.roles.slice();

    if (!supabaseDb.isConfigured()) {
        return cached && now - cached.fetchedAt <= STALE_GRACE_MS ? cached.roles.slice() : [];
    }
    // Kick DDL but NEVER await it here — a cold CREATE TABLE must not push a
    // button-guard reply past Discord's 3-second window.
    kickTableInit();

    try {
        const row = await supabaseDb.queryOne(
            `SELECT raid_admin_roles FROM ${TABLE} WHERE guild_id = $1`,
            [guildId],
            READ_TIMEOUT_MS
        );
        const roles = normalizeRoleIds(row ? row.raid_admin_roles : []);
        roleCache.set(guildId, { roles, fetchedAt: Date.now() });
        return roles.slice();
    } catch (err) {
        console.warn('[raidAdminRoles] read FAILED for guild', guildId, '—', sanitizeError(err));
        if (cached && Date.now() - cached.fetchedAt <= STALE_GRACE_MS) return cached.roles.slice();
        return []; // fail CLOSED
    }
}

/**
 * SYNC cache-only read for code paths that cannot await (button RENDERING in
 * canCloseRaid). Returns [] when nothing confirmed is cached within grace —
 * visibility may lag a database blip, but authorization never does (the async
 * isRaidAdmin re-checks at click time).
 * @param {string} guildId
 * @returns {string[]}
 */
function getCachedRaidAdminRoles(guildId) {
    if (!guildId) return [];
    const cached = roleCache.get(guildId);
    if (!cached) return [];
    if (Date.now() - cached.fetchedAt > STALE_GRACE_MS) return [];
    return cached.roles.slice();
}

/**
 * UPSERTs the authorized raid-admin role IDs for ONE guild, strictly keyed by
 * guild_id. Cache is updated ONLY after the write succeeds; failures rethrow
 * a sanitized error (never the connection string / password).
 * @param {string} guildId
 * @param {string[]} roleIds
 * @returns {Promise<string[]>} the saved role IDs
 */
async function saveRaidAdminRoles(guildId, roleIds) {
    if (!guildId) throw new Error('saveRaidAdminRoles requires a guildId.');
    if (!supabaseDb.isConfigured()) {
        throw new Error('DATABASE_URL is not configured — raid admin roles cannot be saved.');
    }
    const roles = normalizeRoleIds(roleIds).slice(0, MAX_ROLES);
    try {
        // Explicit admin-initiated write — never sit in the DDL backoff window.
        await kickTableInit(true);
        await supabaseDb.runQuery(
            `INSERT INTO ${TABLE} (guild_id, raid_admin_roles, updated_at)
             VALUES ($1, $2::text[], NOW())
             ON CONFLICT (guild_id) DO UPDATE
             SET raid_admin_roles = EXCLUDED.raid_admin_roles,
                 updated_at = NOW()`,
            [guildId, roles],
            WRITE_TIMEOUT_MS
        );
    } catch (err) {
        // Cache untouched on failure — the previous confirmed roles stay valid.
        throw new Error('Could not save raid admin roles: ' + sanitizeError(err));
    }
    roleCache.set(guildId, { roles, fetchedAt: Date.now() });
    return roles;
}

/**
 * THE authorization primitive for raid actions.
 *
 * Returns true only when, in the guild identified by `guildId`:
 *   1. `member` belongs to that guild (strict isolation — a mismatched member
 *      object is rejected before anything else), AND
 *   2. `member` holds the Discord **Administrator** permission there, OR
 *   3. `member` holds at least one role listed in that SAME guild's
 *      `guild_configs.raid_admin_roles` (set via /adminsetup).
 *
 * Staff roles configured in any other guild are never consulted.
 *
 * @param {import('discord.js').GuildMember|null} member — interaction.member
 * @param {string} guildId — interaction.guildId
 * @returns {Promise<boolean>}
 */
async function isRaidAdmin(member, guildId) {
    if (!member || !guildId) return false;
    // Strict isolation: never authorize a member object from another guild.
    const memberGuildId = member.guild && member.guild.id;
    if (memberGuildId && memberGuildId !== guildId) return false;
    try {
        if (member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    } catch (_) { /* fall through to the role check */ }

    const adminRoles = await getRaidAdminRoles(guildId);
    if (!adminRoles.length) return false;
    try {
        const cache = member.roles && member.roles.cache;
        if (!cache) return false;
        if (typeof cache.keys === 'function') {
            for (const roleId of cache.keys()) {
                if (adminRoles.includes(roleId)) return true;
            }
        } else if (Array.isArray(cache)) {
            for (const roleId of cache) {
                if (adminRoles.includes(roleId)) return true;
            }
        }
    } catch (_) { /* a broken role cache must fail closed */ }
    return false;
}

/**
 * The exact ephemeral denial shown when a raid action button/modal is pressed
 * by someone who is neither the requester nor a raid admin of THIS guild.
 * @param {{requesterId?: string}|null} raid
 * @returns {string}
 */
function buildRaidAccessDeniedMessage(raid) {
    const requesterId = raid && raid.requesterId ? raid.requesterId : '';
    return '❌ **Access Denied:** Only the original Raid Requester (<@' + requesterId +
        '>) or a designated Admin in this server can edit or end this raid.';
}

module.exports = {
    isRaidAdmin,
    getRaidAdminRoles,
    getCachedRaidAdminRoles,
    saveRaidAdminRoles,
    buildRaidAccessDeniedMessage,
    normalizeRoleIds,
    TABLE_NAME: TABLE,
    MAX_ROLES,
    READ_TIMEOUT_MS,
    // ---- test seams (never used at runtime) ----
    _resetCacheForTests() {
        roleCache.clear();
        tableInit.inFlight = null;
        tableInit.ok = false;
        tableInit.lastFailureAt = 0;
        warnedUnconfigured = false;
    },
    _seedCacheForTests(guildId, roles, ageMs = 0) {
        roleCache.set(guildId, { roles: normalizeRoleIds(roles), fetchedAt: Date.now() - ageMs });
    }
};


