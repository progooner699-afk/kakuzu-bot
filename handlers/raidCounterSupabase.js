const supabaseDb = require('./supabaseDb');

/**
 * raidCounterSupabase.js — minimal per-guild raid counter persistence.
 * Only stores the numeric last_raid_id. No raid details, embeds, or other data.
 */

function requireDb() {
    if (!supabaseDb.isConfigured()) {
        throw new Error('DATABASE_URL is not configured — raid counter storage is unavailable.');
    }
}

async function getRaidCounter(guildId) {
    requireDb();
    if (!guildId) return 0;
    const row = await supabaseDb.queryOne(
        'SELECT last_raid_id FROM kakuzu_raid_counter WHERE guild_id = ',
        [guildId]
    );
    return row ? (Number(row.last_raid_id) || 0) : 0;
}

async function setRaidCounter(guildId, counter) {
    requireDb();
    if (!guildId) return;
    const sql = 'INSERT INTO kakuzu_raid_counter (guild_id, last_raid_id, updated_at) VALUES (, , NOW()) ON CONFLICT (guild_id) DO UPDATE SET last_raid_id = , updated_at = NOW()';
    await supabaseDb.runQuery(sql, [guildId, Number(counter) || 0]);
}

module.exports = {
    getRaidCounter,
    setRaidCounter,
};
