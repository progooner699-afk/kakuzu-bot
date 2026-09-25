'use strict';

/*
 * robloxLinks.js — ONE shared global Roblox-link service (Supabase authoritative).
 *
 * A Discord user links their Roblox account ONCE globally:
 *   discord_user_id -> Roblox account (no guild_id anywhere in these queries).
 * Every Kakuzu guild (raid request, Help button, presence checks) reads the
 * same row via getGlobalRobloxLink(discordUserId).
 *
 * Contract (mirrors handlers/sharedPingDb.js):
 *  1. Supabase (kakuzu_roblox_links) is the PERMANENT source of truth; the
 *     in-memory Map is a speed layer ONLY.
 *  2. One reusable pool, borrowed from sharedPingDb (no second pool).
 *  3. Schema is created idempotently; startup never DROPs/deletes link rows
 *     and never inserts empty rows.
 *  4. A failed read NEVER poisons the cache and NEVER looks like "not linked".
 *  5. Errors are logged via sharedPingDb.sanitizeError — secrets never printed.
 *  6. Writes are upserts; duplicate Roblox IDs are rejected, never stolen.
 */

const sharedPingDb = require('./sharedPingDb');
const { withTimeout } = require('./fetchTimeout');

const LINKS_QUERY_TIMEOUT_MS = 8000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

const CREATE_LINKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kakuzu_roblox_links (
    discord_user_id TEXT PRIMARY KEY,
    roblox_user_id TEXT NOT NULL,
    roblox_username TEXT NOT NULL,
    roblox_display_name TEXT,
    roblox_avatar_url TEXT,
    verified BOOLEAN NOT NULL DEFAULT TRUE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const ALTER_LINKS_TABLE_SQL = [
    'ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS roblox_display_name TEXT',
    'ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS roblox_avatar_url TEXT',
    'ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT TRUE',
    'ALTER TABLE kakuzu_roblox_links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
];

let linksTableReadyPromise = null;
function ensureLinksTable() {
    if (!linksTableReadyPromise) {
        if (!sharedPingDb.isDatabaseConfigured()) {
            linksTableReadyPromise = Promise.resolve(false);
        } else {
            linksTableReadyPromise = (async () => {
                try {
                    await sharedPingDb.runPoolQuery(CREATE_LINKS_TABLE_SQL, [], LINKS_QUERY_TIMEOUT_MS);
                    for (const sql of ALTER_LINKS_TABLE_SQL) {
                        await sharedPingDb.runPoolQuery(sql, [], LINKS_QUERY_TIMEOUT_MS);
                    }
                    await sharedPingDb.runPoolQuery(
                        'CREATE INDEX IF NOT EXISTS idx_roblox_links_roblox_user_id ON kakuzu_roblox_links (roblox_user_id)',
                        [], LINKS_QUERY_TIMEOUT_MS);
                    return true;
                } catch (err) {
                    console.warn('[robloxLinks] table init failed (will retry lazily):', sharedPingDb.sanitizeError(err));
                    linksTableReadyPromise = null;
                    return false;
                }
            })();
        }
    }
    return linksTableReadyPromise;
}

const linkCache = new Map();
const negativeCache = new Map();

function cacheKey(id) { return String(id || '').trim(); }
function getCachedLink(discordUserId) {
    const row = linkCache.get(cacheKey(discordUserId));
    return row ? Object.assign({}, row) : null;
}
function setCachedLink(row) {
    if (!row || !row.discord_user_id) return;
    linkCache.set(cacheKey(row.discord_user_id), Object.assign({}, row));
    negativeCache.delete(cacheKey(row.discord_user_id));
}
function dropCachedLink(discordUserId) {
    linkCache.delete(cacheKey(discordUserId));
    negativeCache.delete(cacheKey(discordUserId));
}
function clearLinkCache() {
    linkCache.clear();
    negativeCache.clear();
}
function isDatabaseConfigured() { return sharedPingDb.isDatabaseConfigured(); }

function mapLinkRow(row) {
    if (!row) return null;
    return {
        discord_user_id: String(row.discord_user_id || ''),
        roblox_user_id: row.roblox_user_id == null ? null : String(row.roblox_user_id),
        roblox_username: row.roblox_username || null,
        roblox_display_name: row.roblox_display_name || null,
        roblox_avatar_url: row.roblox_avatar_url || null,
        verified: row.verified !== false,
        linked_at: row.linked_at || null,
        updated_at: row.updated_at || null,
    };
}

function isUniqueRobloxIdViolation(err) {
    if (err && String(err.code) === '23505') return true;
    const msg = String((err && err.message) || err || '');
    return /uq_kakuzu_roblox_links_roblox_user_id/i.test(msg) ||
        (/duplicate key/i.test(msg) && /roblox_user_id/i.test(msg));
}

async function getGlobalRobloxLink(discordUserId) {
    const id = cacheKey(discordUserId);
    if (!id) return { ok: true, link: null };
    const cached = getCachedLink(id);
    if (!sharedPingDb.isDatabaseConfigured()) {
        if (cached) return { ok: true, link: cached };
        return { ok: false, unavailable: true, link: null, detail: 'DATABASE_URL is not set.' };
    }
    try {
        await ensureLinksTable();
        const res = await sharedPingDb.runPoolQuery(
            'SELECT discord_user_id, roblox_user_id, roblox_username, roblox_display_name, roblox_avatar_url, verified, linked_at, updated_at FROM kakuzu_roblox_links WHERE discord_user_id = $1',
            [id], LINKS_QUERY_TIMEOUT_MS);
        const row = res && res.rows && res.rows[0] ? mapLinkRow(res.rows[0]) : null;
        if (!row) {
            if (cached && cached.verified) return { ok: true, link: cached };
            if (!cached) negativeCache.set(id, Date.now() + NEGATIVE_CACHE_TTL_MS);
            return { ok: true, link: null };
        }
        setCachedLink(row);
        return { ok: true, link: Object.assign({}, row) };
    } catch (err) {
        console.warn('[robloxLinks] lookup failed (cache kept):', sharedPingDb.sanitizeError(err));
        if (cached) return { ok: false, unavailable: true, link: cached, detail: sharedPingDb.sanitizeError(err) };
        return { ok: false, unavailable: true, link: null, detail: sharedPingDb.sanitizeError(err) };
    }
}

async function saveGlobalRobloxLink(discordUserId, robloxAccount) {
    const id = cacheKey(discordUserId);
    const robloxUserId = robloxAccount && robloxAccount.robloxUserId != null ? String(robloxAccount.robloxUserId).trim() : '';
    const robloxUsername = robloxAccount && robloxAccount.robloxUsername != null ? String(robloxAccount.robloxUsername).trim() : '';
    if (!id || !robloxUserId || !robloxUsername) {
        throw new Error('saveGlobalRobloxLink requires discordUserId, robloxUserId and robloxUsername.');
    }
    if (!sharedPingDb.isDatabaseConfigured()) {
        throw new Error('DATABASE_URL is not configured — Roblox link cannot be saved.');
    }
    const displayName = robloxAccount.robloxDisplayName != null && String(robloxAccount.robloxDisplayName).trim()
        ? String(robloxAccount.robloxDisplayName).trim() : null;
    const avatarUrl = robloxAccount.robloxAvatarUrl || null;
    await ensureLinksTable();
    let res;
    try {
        res = await withTimeout(sharedPingDb.runPoolQuery(
            'INSERT INTO kakuzu_roblox_links (discord_user_id, roblox_user_id, roblox_username, roblox_display_name, roblox_avatar_url, verified, linked_at, updated_at) VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW()) ON CONFLICT (discord_user_id) DO UPDATE SET roblox_user_id = EXCLUDED.roblox_user_id, roblox_username = EXCLUDED.roblox_username, roblox_display_name = EXCLUDED.roblox_display_name, roblox_avatar_url = EXCLUDED.roblox_avatar_url, verified = TRUE, updated_at = NOW() RETURNING discord_user_id, roblox_user_id, roblox_username, roblox_display_name, roblox_avatar_url, verified, linked_at, updated_at',
            [id, robloxUserId, robloxUsername, displayName, avatarUrl],
        ), LINKS_QUERY_TIMEOUT_MS, 'roblox link save');
    } catch (err) {
        if (isUniqueRobloxIdViolation(err)) {
            const conflict = new Error('This Roblox account is already linked to another Discord account. Unlink it from the original account before trying again.');
            conflict.code = 'ROBLOX_ALREADY_LINKED';
            throw conflict;
        }
        console.warn('[robloxLinks] save failed:', sharedPingDb.sanitizeError(err));
        throw err;
    }
    const row = res && res.rows && res.rows[0] ? mapLinkRow(res.rows[0]) : null;
    if (row) setCachedLink(row);
    return row;
}

async function removeGlobalRobloxLink(discordUserId) {
    const id = cacheKey(discordUserId);
    if (!id) return false;
    if (!sharedPingDb.isDatabaseConfigured()) {
        throw new Error('DATABASE_URL is not configured — Roblox link cannot be removed.');
    }
    await ensureLinksTable();
    const res = await withTimeout(sharedPingDb.runPoolQuery(
        'DELETE FROM kakuzu_roblox_links WHERE discord_user_id = $1 RETURNING discord_user_id',
        [id],
    ), LINKS_QUERY_TIMEOUT_MS, 'roblox link unlink');
    const removed = Boolean(res && res.rows && res.rows.length > 0);
    dropCachedLink(id);
    return removed;
}

async function refreshGlobalRobloxProfile(discordUserId) {
    const found = await getGlobalRobloxLink(discordUserId);
    if (!found.ok) {
        const err = new Error('Kakuzu cannot check your Roblox link right now because the database is temporarily unavailable. Please try again shortly.');
        err.code = 'LINK_DB_UNAVAILABLE';
        throw err;
    }
    if (!found.link || !found.link.roblox_user_id) return null;
    let validation = null;
    try {
        const robloxApi = require('./robloxApi');
        if (found.link.roblox_username) validation = await robloxApi.validateAndGetAvatar(found.link.roblox_username);
    } catch (err) {
        console.warn('[robloxLinks] profile refresh lookup failed:', (err && err.message) || err);
        return found.link;
    }
    if (!validation || validation.success === false) return found.link;
    // validateAndGetAvatar echoes no username field, so keep the stored one.
    const updated = await saveGlobalRobloxLink(discordUserId, {
        robloxUserId: found.link.roblox_user_id,
        robloxUsername: found.link.roblox_username,
        robloxDisplayName: validation.displayName || found.link.roblox_display_name,
        robloxAvatarUrl: validation.avatarUrl || found.link.roblox_avatar_url,
    });
    return updated || found.link;
}

async function initializeAtStartup() {
    if (!sharedPingDb.isDatabaseConfigured()) {
        console.warn('[robloxLinks] DATABASE_URL is not set — global Roblox links unavailable until it is set (Render env).');
        return { ok: false, loaded: 0 };
    }
    const ready = await ensureLinksTable();
    if (!ready) {
        console.warn('[robloxLinks] global links table not ready at startup — will retry lazily.');
        return { ok: false, loaded: 0 };
    }
    console.log('[robloxLinks] global Roblox links table ready (Supabase authoritative).');
    return { ok: true, loaded: 0 };
}

/**
 * Auto-join candidate list: every globally linked user, shaped like the
 * legacy verificationDb.getAllVerifiedUsers rows ({ userId, roblox_username,
 * roblox_display_name, roblox_user_id, roblox_avatar_url }) so the presence
 * engine below is untouched. When the global table is unavailable/empty, falls
 * back to the per-guild legacy mirror for that guild only.
 */
async function getAllGlobalLinksForAutoJoin(guildId) {
    let globalRows = [];
    try {
        await ensureLinksTable();
        const res = await sharedPingDb.runPoolQuery(
            'SELECT discord_user_id, roblox_user_id, roblox_username, roblox_display_name, roblox_avatar_url FROM kakuzu_roblox_links WHERE verified = TRUE',
            [], LINKS_QUERY_TIMEOUT_MS);
        globalRows = (res && res.rows ? res.rows : [])
            .map((r) => ({
                userId: String(r.discord_user_id || ''),
                roblox_username: r.roblox_username || null,
                roblox_display_name: r.roblox_display_name || null,
                roblox_user_id: r.roblox_user_id == null ? null : String(r.roblox_user_id),
                roblox_avatar_url: r.roblox_avatar_url || null,
            }))
            .filter((u) => u.userId && u.roblox_user_id && u.roblox_user_id !== '1');
        for (const u of globalRows) {
            setCachedLink({
                discord_user_id: u.userId,
                roblox_user_id: u.roblox_user_id,
                roblox_username: u.roblox_username,
                roblox_display_name: u.roblox_display_name,
                roblox_avatar_url: u.roblox_avatar_url,
                verified: true,
                linked_at: null,
                updated_at: null,
            });
        }
    } catch (err) {
        console.warn('[robloxLinks] auto-join global read failed (legacy fallback):', sharedPingDb.sanitizeError(err));
        globalRows = [];
    }
    if (globalRows.length > 0) return globalRows;
    try {
        const verificationDb = require('./verificationDb');
        if (guildId) return await verificationDb.getAllVerifiedUsers(guildId);
    } catch (err) {
        console.warn('[robloxLinks] legacy auto-join fallback failed:', (err && err.message) || err);
    }
    return globalRows;
}

module.exports = {
    getGlobalRobloxLink,
    saveGlobalRobloxLink,
    removeGlobalRobloxLink,
    refreshGlobalRobloxProfile,
    getAllGlobalLinksForAutoJoin,
    initializeAtStartup,
    ensureLinksTable,
    isDatabaseConfigured,
    clearLinkCache,
    _getCacheSize: () => linkCache.size,
};




