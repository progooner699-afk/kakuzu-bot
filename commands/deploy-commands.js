const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('../config.json');
const commandHandler = require('../handlers/commandHandler');

async function run() {
    const commands = commandHandler.getCommandDataArray();
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        const route = config.guildId
            ? Routes.applicationGuildCommands(config.clientId, config.guildId)
            : Routes.applicationCommands(config.clientId);

        await rest.put(route, { body: commands });
        console.log('Slash commands deployed successfully.');
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        throw error;
    }
}

if (require.main === module) {
    run().catch(() => process.exit(1));
}

module.exports = { run };
