const path = require('path');
const { REST, Routes } = require('discord.js');

// This explicitly loads the .env file from the parent directory
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const config = require('../config.json');
const commandHandler = require('../handlers/commandHandler');

async function run() {
    const commands = commandHandler.getCommandDataArray();
    
    // Grabs the token that was just loaded from your root .env file
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        console.error('❌ Error: No DISCORD_TOKEN found in your environment (.env file).');
        process.exit(1);
    }

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        // Allow forcing global (application) commands via env var GLOBAL_COMMANDS=true
        const useGlobal = process.env.GLOBAL_COMMANDS === 'true';
        const route = useGlobal
            ? Routes.applicationCommands(config.clientId)
            : (config.guildId
                ? Routes.applicationGuildCommands(config.clientId, config.guildId)
                : Routes.applicationCommands(config.clientId));

        console.log(`🔄 Registering slash command layouts to Discord (${useGlobal ? 'GLOBAL' : (config.guildId ? `GUILD ${config.guildId}` : 'GLOBAL')} mode)...`);
        await rest.put(route, { body: commands });
        console.log('✅ Slash commands deployed successfully.');
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        throw error;
    }
}

if (require.main === module) {
    run().catch(() => process.exit(1));
}

// Register this bot's slash commands to a single guild.
// Guild-scoped commands appear INSTANTLY (no propagation delay) and are the
// recommended way to make commands available in a server the bot is in.
async function registerGuildCommands(guildId) {
    const commands = commandHandler.getCommandDataArray();
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error('No DISCORD_TOKEN found in environment (.env file).');
    }
    const rest = new REST({ version: '10' }).setToken(token);
    const route = Routes.applicationGuildCommands(config.clientId, guildId);
    await rest.put(route, { body: commands });
    console.log(`✅ Registered ${commands.length} slash commands to guild ${guildId}.`);
    return commands.length;
}

module.exports = { run, registerGuildCommands };