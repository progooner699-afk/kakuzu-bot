require('dotenv').config();
const fs = require('fs');
const path = require('path');
const apiServer = require('./handlers/apiServer');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const config = require('./config.json');
const commandHandler = require('./handlers/commandHandler');
const raidStateManager = require('./handlers/raidStateManager');

// FIXED: Added GuildMessages, MessageContent and GuildMembers for verification DMs
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ] 
});

client.commands = new Collection();
client.raidStateManager = raidStateManager;

// Process-level safety nets: a single unhandled promise rejection would by
// default CRASH the whole process (making EVERY command stop working). Log it
// and keep the bot alive so a stray error in a collector/poller can't take the
// bot offline.
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled promise rejection (keeping bot alive):', reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught exception (keeping bot alive):', error && error.stack ? error.stack : error);
});

commandHandler.loadCommands(client);
console.log(`📦 Loaded ${client.commands.size} slash command(s).`);

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
        client.once(event.name, (...args) => {
            event.execute(...args, client).catch(error => console.error(`Event ${event.name} error:`, error));
        });
    } else {
        client.on(event.name, (...args) => {
            event.execute(...args, client).catch(error => console.error(`Event ${event.name} error:`, error));
        });
    }
}

raidStateManager.ensureDataFiles();

// Express API server for the React dashboard (keep-alive + stats/actions).
// The app is built here so the same single HTTP server serves the dashboard
// endpoints and the protected guild-roles endpoint.
const app = apiServer.createApiServer(client);
const port = process.env.PORT || 5000;

app.listen(port, () => console.log(`API server running on port ${port}`));

// Discord bot login
client.login(process.env.DISCORD_TOKEN);
