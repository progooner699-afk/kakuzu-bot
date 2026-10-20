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
        // Explicit opt-in for global (application) commands via env var.
        const useGlobal = process.env.GLOBAL_COMMANDS === 'true';
        if (useGlobal) {
            console.log('🔄 Registering GLOBAL slash commands (GLOBAL_COMMANDS=true)...');
            await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
            console.log('✅ Global slash commands deployed successfully.');
            return;
        }

        // DEFAULT: guild-scoped commands only. Registering BOTH guild and
        // global commands makes Discord show TWO copies of every command, so
        // the global set is cleared here and every bot guild gets the fresh
        // layout instantly (no global propagation delay).
        const guilds = await rest.get(Routes.userGuilds());
        if (!Array.isArray(guilds) || guilds.length === 0) {
            console.log('⚠️ Bot is not in any guilds — falling back to global registration.');
            await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
            console.log('✅ Global slash commands deployed successfully.');
            return;
        }

        console.log(`🔄 Registering slash commands in ${guilds.length} guild(s) and clearing global duplicates...`);
        // Clear the global set first — this is what removes the duplicated
        // commands users see when global + guild copies both exist.
        await rest.put(Routes.applicationCommands(config.clientId), { body: [] });

        let ok = 0;
        for (const g of guilds) {
            try {
                await rest.put(Routes.applicationGuildCommands(config.clientId, g.id), { body: commands });
                ok++;
            } catch (err) {
                console.warn(`⚠️ Failed to register commands for guild ${g.name || g.id}:`, (err && err.message) || err);
            }
        }
        console.log(`✅ Slash commands deployed to ${ok}/${guilds.length} guild(s); global duplicates removed.`);
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        throw error;
    }
}

if (require.main === module) {
    run().catch((error) => {
        // Print the real failure (validation errors, auth, rate limits) before
        // exiting non-zero — a silent exit hides the reason a deploy failed.
        console.error('❌ Deploy failed:', (error && (error.stack || error.message)) || error);
        process.exit(1);
    });
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

// Removes ALL global (application-wide) slash commands. Guild-scoped commands
// are the single source of truth in this bot — when global AND guild commands
// are both registered, Discord shows TWO copies of every command in servers.
async function clearGlobalCommands() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error('No DISCORD_TOKEN found in environment (.env file).');
    }
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
    console.log('🧹 Cleared global slash commands (guild-scoped commands are the single source of truth).');
}

module.exports = { run, registerGuildCommands, clearGlobalCommands };