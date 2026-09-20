const guildAccess = require('../handlers/guildAccess');

module.exports = {
    name: 'guildDelete',
    once: false,
    async execute(guild, client) {
        // Preserve the access record (bot_present=false, left audit event).
        // Access status is NOT revoked so a re-invite restores prior access.
        try {
            await guildAccess.handleGuildLeave(client, guild.id);
        } catch (error) {
            console.error(`guildDelete handling failed for ${guild.id}:`, (error && error.message) || error);
        }
    },
};