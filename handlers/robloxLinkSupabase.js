const supabaseDb = require('./supabaseDb');

/*
 * robloxLinkSupabase.js
 *
 * Permanent Roblox link storage in Supabase (kakuzu_roblox_links).
 * Acts as the AUTHORITATIVE store; in-memory usage is derived from it on demand.
 *
 * On link:
 *   - INSERT INTO kakuzu_roblox_links (discord_user_id, roblox_user_id, roblox_username, linked_at)
 *     ON CONFLICT(discord_user_id) DO UPDATE  (re-linking a different Roblox account
 *     overwrites the old link for that Discord user).
 *   - Returns the saved row.
 *
 * On lookup:
 *   - SELECT * FROM kakuzu_roblox_links WHERE discord_user_id = $1
 *   - Returns null if not linked.
 *
 * On unlink:
 *   - DELETE FROM kakuzu_roblox_links WHERE discord_user_id = $1
 *   - Only the Discord user who owns the link may unlink (checked by the caller).
 *   - Returns true if a row was deleted.
 *
 * getLinkedRobloxUserId:
 *   - SELECT roblox_user_id FROM kakuzu_roblox_links WHERE discord_user_id = $1
 *   - Returns the Roblox user ID string, or null.
 *
 * List all links (for stats / diagnostics, NOT for automatic removal):
 *   - SELECT * FROM kakuzu_roblox_links ORDER BY linked_at DESC
 *   - Never used to auto-unlink during startup or deployment.
 *
 * ALL functions require DATABASE_URL to be configured.  If not, they throw a clear
 * error rather than silently saving to nowhere or returning fake data.
 */

function requireDb() {
    if (!supabaseDb.isConfigured()) {
        throw new Error('DATABASE_URL is not configured — Roblox link storage is unavailable.');
    }
}

async function linkRobloxAccount(userId, robloxUserId, robloxUsername) {
    requireDb();
    if (!userId || !robloxUserId || !robloxUsername) {
        throw new Error('linkRobloxAccount requires userId, robloxUserId and robloxUsername.');
    }
    const now = new Date().toISOString();
    const result = await supabaseDb.runQuery(
        `INSERT INTO kakuzu_roblox_links (discord_user_id, roblox_user_id, roblox_username, linked_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (discord_user_id) DO UPDATE SET
             roblox_user_id = $2,
             roblox_username = $3,
             linked_at = $4
         RETURNING *`,
        [userId, String(robloxUserId), robloxUsername, now]
    );
    return result.rows[0];
}

async function getRobloxLink(userId) {
    requireDb();
    if (!userId) return null;
    const result = await supabaseDb.queryOne(
        `SELECT discord_user_id, roblox_user_id, roblox_username, linked_at
         FROM kakuzu_roblox_links
         WHERE discord_user_id = $1`,
        [userId]
    );
    return result;
}

async function unlinkRobloxAccount(userId) {
    requireDb();
    if (!userId) return false;
    const result = await supabaseDb.runQuery(
        `DELETE FROM kakuzu_roblox_links WHERE discord_user_id = $1 RETURNING *`,
        [userId]
    );
    return result.rows.length > 0;
}

async function getLinkedRobloxUserId(userId) {
    requireDb();
    if (!userId) return null;
    return supabaseDb.queryValue(
        `SELECT roblox_user_id FROM kakuzu_roblox_links WHERE discord_user_id = $1`,
        [userId]
    );
}

async function getAllRobloxLinks() {
    requireDb();
    return supabaseDb.queryAll(
        `SELECT discord_user_id, roblox_user_id, roblox_username, linked_at
         FROM kakuzu_roblox_links
         ORDER BY linked_at DESC`
    );
}

module.exports = {
    linkRobloxAccount,
    getRobloxLink,
    unlinkRobloxAccount,
    getLinkedRobloxUserId,
    getAllRobloxLinks,
};
