require('dotenv').config();
const fs = require('fs');
const path = require('path');
const apiServer = require('./handlers/apiServer');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const config = require('./config.json');
const commandHandler = require('./handlers/commandHandler');
const raidStateManager = require('./handlers/raidStateManager');
const { checkRobloxCookieAuth } = require('./handlers/robloxAuth');
const { attachGatewayGuard, startGatewayWatchdog } = require('./handlers/gatewayGuard');

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

// Gateway self-heal + lifecycle logging: prevents the zombie state where Render
// shows "Live" (HTTP health-check 200) but the bot is actually offline in Discord
// (see handlers/gatewayGuard.js for details)..
attachGatewayGuard(client);
startGatewayWatchdog(client);

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

// Discord bot login - handled explicitly so a boot-time login rejection (Discord
// session_start_limit 429 after repeated Render restarts/or transient Gateway 5xx)
// logs loudly and exits with a non-zero code so Render recycles the service and retries with
// a fresh Discord session budget - instead of sitting "Live" but never connecting..
const loginPromise = client.login(process.env.DISCORD_TOKEN);
loginPromise.then(() => console.log('Discord login OK.')).catch(async (error) => {
    console.error('Discord login FAILED - exiting so Render restarts with a fresh session:', error && error.stack ? error.stack : error);
    try { await client.destroy(); } catch (err) { /* ignore */ }
    process.exit(1);
});

// Graceful shutdown: closes the Discord Gateway connection cleanly(close code
// 1000) so Discord frees the session slot, keeping the session_start_limit budget
// healthy across Render redeploys..
let shuttingDown = false;
function shutdownGracefully(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutdown requested (' + reason + ') - closing Discord connection cleanly...');
    const exitTimer = setTimeout(() => process.exit(0), 3000);
    if (exitTimer.unref) exitTimer.unref();
    client.destroy().then(() => process.exit(0)).catch(() => process.exit(0));
}
process.on('SIGTERM', () => shutdownGracefully('SIGTERM from Render deploy/stop'));
process.on('SIGINT', () => shutdownGracefully('SIGINT manual stop'));
