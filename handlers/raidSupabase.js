const supabaseDb = require('./supabaseDb');

/*
 * raidSupabase.js — permanent raid storage (kakuzu_raids).
 * Every created raid is recorded here with sequential display_number (R-000001, ...).
 * Next number = COALESCE(MAX(display_number),0)+1 per guild, so numbering continues
 * after deployments, crashes and cache resets.  Supabase is the source of truth.
 */

function requireDb() {
    if (!supabaseDb.isConfigured()) {
        throw new Error('DATABASE_URL is not configured — raid history storage is unavailable.');
    }
}

function generateRaidId() {
    const ts = Date.now();
    const hex = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
    return ts + '-' + hex;
}

function formatDisplayId(displayNumber) {
    return 'R-' + String(displayNumber).padStart(6, '0');
}

async function createRaid(guildId, requesterId, raidData) {
    requireDb();
    if (!guildId || !requesterId) {
        throw new Error('createRaid requires guildId and requesterId.');
    }
    const next = await supabaseDb.queryValue(
        `SELECT COALESCE(MAX(display_number), 0) + 1 AS next_num
         FROM kakuzu_raids WHERE guild_id = $1`,
        [guildId]
    );
    const displayNumber = (typeof next === 'number' && !isNaN(next)) ? next : 1;
    const raidId = generateRaidId();
    const now = new Date().toISOString();

    const row = await supabaseDb.runQuery(
        `INSERT INTO kakuzu_raids (
            raid_id, guild_id, display_number, requester_id,
            target_game, place_id, server_id,
            enemy_clan_names, enemy_names,
            region, country_code, reason,
            helper_limit, status, created_at
        ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9,
            $10, $11, $12,
            $13, 'PENDING', $14
        ) RETURNING *`,
        [
            raidId, guildId, displayNumber, requesterId,
            raidData.targetGame || null,
            raidData.placeId != null ? String(raidData.placeId) : null,
            raidData.serverId != null ? String(raidData.serverId) : null,
            raidData.enemyClanNames != null ? String(raidData.enemyClanNames) : null,
            raidData.enemyNames != null ? String(raidData.enemyNames) : null,
            raidData.region || null,
            raidData.countryCode || null,
            raidData.reason || null,
            raidData.helperLimit != null ? Number(raidData.helperLimit) : 5,
            now,
        ]
    );
    const saved = row.rows[0];
    return {
        raid_id: saved.raid_id,
        display_number: saved.display_number,
        display_id: formatDisplayId(saved.display_number),
        supabaseRow: saved,
    };
}

async function getRaidByInternalId(raidId) {
    requireDb();
    if (!raidId) return null;
    return supabaseDb.queryOne(`SELECT * FROM kakuzu_raids WHERE raid_id = $1`, [raidId]);
}

async function getRaidsByGuildId(guildId) {
    requireDb();
    if (!guildId) return [];
    return supabaseDb.queryAll(
        `SELECT * FROM kakuzu_raids WHERE guild_id = $1 ORDER BY display_number`,
        [guildId]
    );
}

async function getRaidsCount(guildId) {
    requireDb();
    if (!guildId) return 0;
    return supabaseDb.queryValue(
        `SELECT COUNT(*) AS cnt FROM kakuzu_raids WHERE guild_id = $1`, [guildId]
    ) || 0;
}

module.exports = {
    generateRaidId,
    formatDisplayId,
    createRaid,
    getRaidByInternalId,
    getRaidsByGuildId,
    getRaidsCount,
};


async function getNextDisplayNumber(guildId) {
    requireDb();
    if (!guildId) return 1;
    const val = await supabaseDb.queryValue(
        `SELECT COALESCE(MAX(display_number), 0) + 1 AS next_num
         FROM kakuzu_raids WHERE guild_id = $1`,
        [guildId]
    );
    return (typeof val === 'number' && !isNaN(val)) ? val : 1;
}

async function updateRaidStatus(raidId, status) {
    requireDb();
    if (!raidId || !status) return;
    await supabaseDb.runQuery(
        `UPDATE kakuzu_raids SET status = $2 WHERE raid_id = $1`,
        [raidId, status]
    );
}

async function closeRaid(raidId, outcome, mvpUserId, resultChannelId, raidMessageId, alertChannelId) {
    requireDb();
    if (!raidId) return;
    await supabaseDb.runQuery(
        `UPDATE kakuzu_raids SET
            status = 'CLOSED',
            outcome = $2,
            mvp_user_id = $3,
            result_channel_id = $4,
            raid_message_id = $5,
            alert_channel_id = $6,
            ended_at = NOW()
         WHERE raid_id = $1`,
        [
            raidId,
            outcome || null,
            mvpUserId != null ? String(mvpUserId) : null,
            resultChannelId != null ? String(resultChannelId) : null,
            raidMessageId != null ? String(raidMessageId) : null,
            alertChannelId != null ? String(alertChannelId) : null,
        ]
    );
}

async function updateRaidMessageReference(raidId, messageId) {
    requireDb();
    if (!raidId || !messageId) return;
    await supabaseDb.runQuery(
        `UPDATE kakuzu_raids SET raid_message_id = $2 WHERE raid_id = $1`,
        [raidId, messageId]
    );
}

async function updateRaidAlertChannel(raidId, alertChannelId) {
    requireDb();
    if (!raidId || !alertChannelId) return;
    await supabaseDb.runQuery(
        `UPDATE kakuzu_raids SET alert_channel_id = $2 WHERE raid_id = $1`,
        [raidId, alertChannelId]
    );
}

module.exports = Object.assign(module.exports, {
    getNextDisplayNumber,
    updateRaidStatus,
    closeRaid,
    updateRaidMessageReference,
    updateRaidAlertChannel,
});
