require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
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

// Express API server for the React dashboard (keep-alive + stats/actions)
const app = express();
const port = process.env.PORT || 5000;

// Allow local frontend (CORS) + JSON request bodies
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('Kakuzu is Online!'));

// Bot statistics endpoint (consumed by the React dashboard)
app.get('/api/stats', (req, res) => {
    res.json({
        servers: client.guilds.cache.size,
        users: client.users.cache.size,
        ping: client.ws.ping,
        status: client.isReady() ? 'Online' : 'Offline'
    });
});

// Restart/reconnect endpoint (consumed by the React dashboard)
app.post('/api/action/restart', async (req, res) => {
    res.json({ success: true, message: 'Bot restarting...' });
    console.log('[API] Restart requested — reconnecting Discord client...');
    try {
        await client.destroy();
        await client.login(process.env.DISCORD_TOKEN);
        console.log('[API] Bot reconnected successfully.');
    } catch (error) {
        console.error('[API] Restart failed:', error);
    }
});

app.listen(port, () => console.log(`API server running on port ${port}`));

// Discord bot login
client.login(process.env.DISCORD_TOKEN);
