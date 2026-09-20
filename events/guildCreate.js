const { registerGuildCommands } = require('../commands/deploy-commands');
const guildAccess = require('../handlers/guildAccess');

module.exports = {
    name: 'guildCreate',
    once: false,
    async execute(guild, client) {
        // Permanent premium-access pipeline: Supabase upsert (preserves
        // access_status) + single onboarding channel for locked guilds only.
        // Granted guilds keep access active with no new channel.
        try {
            await guildAccess.handleGuildJoin(client, guild, registerGuildCommands);
        } catch (error) {
            console.error(`guildCreate pipeline failed for ${guild.id}:`, (error && error.message) || error);
            try {
                await registerGuildCommands(guild.id);
            } catch (err) {
                console.error(`Fallback command registration failed for ${guild.id}:`, (err && err.message) || err);
            }
        }
    },
};