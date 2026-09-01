require('dotenv').config();
const fs = require('fs');
const path = require('path');
const apiServer = require('./handlers/apiServer');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const config = require('./config.json');
const commandHandler = require('./handlers/commandHandler');
const raidStateManager = require('./handlers/raidStateManager');
const { checkRobloxCookieAuth } = require('./handlers/robloxAuth');
const { attachGatewayGuard, reconnectDiscord, markShuttingDown } = require('./handlers/gatewayGuard');

// Added GuildMessages, MessageContent and GuildMembers for verification DMs
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

// Gateway lifecycle logging + manual reconnect helper.
// discord.js v14 auto-reconnects recoverable close codes; the old watchdog
// timer that polled and re-logged has been REMOVED to prevent races with
// the SIGTERM graceful-shutdown handler (see handlers/gatewayGuard.js).
attachGatewayGuard(client);

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
const server = app.listen(port, () => console.log(`API server running on port ${port}`));

// Safe .ROBLOSECURITY authenticated-cookie diagnostic run ONCE at startup so it
// shows up in normal Render service logs (free Render has no shell to run the
// standalone diagnose-cookie.js script). Logs ONLY non-sensitive flags
// (cookieConfigured/cookieLength/authCheck/httpStatus/replacementCookieReceived);
// never prints, hashes, or reveals the cookie value. `force=true` guarantees it
// runs at boot regardless of the pre-gamejoin throttle TTL. Fire-and-forget so a
// slow/failed Roblox probe can never delay or crash startup.
checkRobloxCookieAuth('startup', true).catch(err => {
    console.error('[robloxAuth] startup cookie diagnostic failed (bot kept alive):', err && err.stack ? err.stack : err);
});

// Discord bot login - called exactly once during startup.
console.log('[discordAuth] Discord token configured:', !!process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN.length > 10);
console.log('[discordAuth] Starting Discord login...');
const loginPromise = client.login(process.env.DISCORD_TOKEN);
loginPromise.then(() => console.log('[discordAuth] Discord login OK.')).catch(async (error) => {
    console.error('[discordAuth] Discord login FAILED - exiting so Render restarts with a fresh session:', error && error.stack ? error.stack : error);
    try { await client.destroy(); } catch (err) { /* ignore */ }
    process.exit(1);
});

// Graceful shutdown: triggered by SIGTERM (Render deploy/stop) or SIGINT (Ctrl-C).
// Sets isShuttingDown BEFORE destroying the client so reconnectDiscord() and
// any pending timers are short-circuited. Then closes the Express server
// and destroys the Discord client, exiting with code 0.
let isShuttingDown = false;
function shutdownGracefully(reason) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('SIGTERM received - shutting down cleanly...');
    markShuttingDown(client);

    if (server) {
        server.close(() => {
            console.log('HTTP server closed.');
        });
    }

    client.destroy().then(() => {
        console.log('Shutdown complete.');
        process.exit(0);
    }).catch(() => process.exit(0));
}
process.on('SIGTERM', () => shutdownGracefully('SIGTERM from Render deploy/stop'));
process.on('SIGINT', () => shutdownGracefully('SIGINT manual stop'));
