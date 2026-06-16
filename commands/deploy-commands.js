const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('../config.json');
const commandHandler = require('../handlers/commandHandler');

const commands = commandHandler.getCommandDataArray();
const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
    try {
        const route = config.guildId
            ? Routes.applicationGuildCommands(config.clientId, config.guildId)
            : Routes.applicationCommands(config.clientId);

        await rest.put(route, { body: commands });
        console.log('Slash commands deployed successfully.');
    } catch (error) {
        console.error('Failed to deploy commands:', error);
    }
})();
