const { registerGuildCommands } = require('../commands/deploy-commands');

module.exports = {
    name: 'guildCreate',
    once: false,
    async execute(guild, client) {
        // The bot was just added to a new server. Register commands here so they
        // appear INSTANTLY — no manual deploy and no global propagation delay.
        try {
            await registerGuildCommands(guild.id);
            console.log(`👋 Joined "${guild.name}" (${guild.id}) — slash commands registered.`);
        } catch (error) {
            console.error(`❌ Failed to register commands for new guild ${guild.id} (${guild.name}):`, error);
        }
    },
};