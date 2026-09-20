const supabaseDb = require('./supabaseDb');

/*
 * raidChannelSupabase.js
 *
 * Permanent raid-result channel storage per guild (kakuzu_raid_channels).
 * Only the raid-result channel is stored here — no raid-alert, raid-log,
 * verification, backup-panel or other channel settings.
 *
 * setRaidResultChannel(guildId, channelId):
 *   INSERT INTO kakuzu_raid_channels (guild_id, channel_id, updated_at)
 *     ON CONFLICT(guild_id) DO UPDATE SET channel_id = $2, updated_at = NOW()
 *   Returns the saved row.
 *
 * getRaidResultChannel(guildId):
 *   SELECT channel_id FROM kakuzu_raid_channels WHERE guild_id = $1
 *   Returns the channel ID string, or null.
 *
 * getRaidResultChannelRow(guildId):
 *   SELECT * FROM kakuzu_raid_channels WHERE guild_id = $1
 *   Returns full row or null.
 *
 * ALL functions require DATABASE_URL.  If not configured they throw rather than
 * silently saving to nowhere.
 */

function requireDb() {
    if (!supabaseDb.isConfigured()) {
        throw new Error('DATABASE_URL is not configured — raid channel storage is unavailable.');
    }
}

async function setRaidResultChannel(guildId, channelId) {
    requireDb();
    if (!guildId || !channelId) {
        throw new Error('setRaidResultChannel requires guildId and channelId.');
    }
    const result = await supabaseDb.runQuery(
        `INSERT INTO kakuzu_raid_channels (guild_id, channel_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (guild_id) DO UPDATE SET
             channel_id = $2,
             updated_at = NOW()
         RETURNING *`,
        [guildId, channelId]
    );
    return result.rows[0];
}

async function getRaidResultChannel(guildId) {
    requireDb();
    if (!guildId) return null;
    return supabaseDb.queryValue(
        `SELECT channel_id FROM kakuzu_raid_channels WHERE guild_id = $1`,
        [guildId]
    );
}

async function getRaidResultChannelRow(guildId) {
    requireDb();
    if (!guildId) return null;
    return supabaseDb.queryOne(
        `SELECT guild_id, channel_id, updated_at
         FROM kakuzu_raid_channels
         WHERE guild_id = $1`,
        [guildId]
    );
}

module.exports = {
    setRaidResultChannel,
    getRaidResultChannel,
    getRaidResultChannelRow,
};
