require('dotenv').config();
const fs = require('fs');
const path = require('path');
const apiServer = require('./handlers/apiServer');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const config = require('./config.json');
const commandHandler = require('./handlers/commandHandler');
const raidStateManager = require('./handlers/raidStateManager');
const sharedPingDb = require('./handlers/sharedPingDb');
const dbKeepAlive = require('./handlers/dbKeepAlive');
const { checkRobloxCookieAuth } = require('./handlers/robloxAuth');
const { attachGatewayGuard, reconnectDiscord, markShuttingDown, startGatewayWatchdog } = require('./handlers/gatewayGuard');

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

// Gateway lifecycle logging + SHUTDOWN-SAFE self-heal watchdog.
// discord.js v14 auto-reconnects recoverable close codes, but it CANNOT recover
// from an unrecoverable close (or a boot login that never reaches READY) — the
// process then stays green on Render while ignoring every command. The watchdog
// (handlers/gatewayGuard.js) reconnects only after a 45s grace period, is
// rate-limit-aware, and is disarmed inside markShuttingDown() BEFORE the client
// is destroyed, which is exactly what the removed 0b626e9 version got wrong.
attachGatewayGuard(client);

// Safe Discord connection-lifecycle logging (never tokens/cookies/env values).
client.on('clientReady', (c) => {
    console.log(`[discord] ready as ${c?.user?.tag || 'unknown'} guilds=${c?.guilds?.cache?.size ?? 0}`);
});
client.on('shardReady', (shardId) => {
    console.log(`[discord] shard ${shardId} ready`);
});
client.on('shardDisconnect', (event, shardId) => {
    console.log(`[discord] shard ${shardId} disconnected (code=${event?.code ?? 'unknown'})`);
});
client.on('shardReconnecting', (shardId) => {
    console.log(`[discord] shard ${shardId} reconnecting`);
});
client.on('shardResume', (shardId, replayed) => {
    console.log(`[discord] shard ${shardId} resumed (replayed=${replayed})`);
});
client.on('shardError', (error, shardId) => {
    console.error(`[discord] shard ${shardId} error:`, error && error.message ? error.message : error);
});
client.on('error', (error) => {
    console.error('[discord] client error:', error && error.stack ? error.stack : (error && error.message ? error.message : error));
});
client.on('warn', (info) => {
    console.warn('[discord] warn:', info);
});

// Process-level safety nets: log message + stack, never tokens/cookies/env values.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled promise rejection:', reason instanceof Error ? (reason.stack || reason.message) : reason);
});
process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught exception:', error && error.stack ? error.stack : error);
});

commandHandler.loadCommands(client);
console.log(`📦 Loaded ${client.commands.size} slash command(s).`);

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
const registeredEvents = [];
for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    const register = event.once ? client.once.bind(client) : client.on.bind(client);
    register(event.name, (...args) => {
        event.execute(...args, client).catch(error => console.error(`Event ${event.name} error:`, error));
    });
    registeredEvents.push(event.name);
}
console.log(`🔌 Registered ${registeredEvents.length} event listener(s): ${registeredEvents.join(', ')}`);

// PREMIUM-ACCESS WIRING PROOF (fail loudly, never silently):
// The fail-closed access guard lives in events/interactionCreate.js and the
// `kakuzu-access` onboarding channel is created by events/guildCreate.js. If a
// listener is missing (renamed file / broken export) the premium-access system
// would keep "looking" healthy while enforcing nothing — so verify at startup.
const REQUIRED_LISTENERS = ['interactionCreate', 'guildCreate', 'guildDelete', 'clientReady'];
const missingListeners = REQUIRED_LISTENERS.filter(name => !registeredEvents.includes(name));
if (missingListeners.length > 0) {
    console.error(`❌ Premium-access wiring INCOMPLETE — missing event listener(s): ${missingListeners.join(', ')}`);
} else {
    console.log('🔒 Premium-access wired: interactionCreate (fail-closed guild guard) + guildCreate (kakuzu-access onboarding).');
}
// Exactly ONE interactionCreate listener may exist — a second handler would
// run without the guard and could execute commands in locked guilds.
const interactionHandlerCount = registeredEvents.filter(name => name === 'interactionCreate').length;
if (interactionHandlerCount !== 1) {
    console.error(`❌ Expected exactly 1 interactionCreate handler, found ${interactionHandlerCount} — the access guard may be bypassed.`);
}

raidStateManager.ensureDataFiles();

// Startup database health check + cache preload for guild ping settings.
// PostgreSQL is the PERMANENT source of truth — this ONLY warms the in-memory
// cache so raid alerts never block on a cold DB. Fire-and-forget: a slow or
// down database can never delay or crash Discord login, and it never deletes
// or resets the saved settings (no row is ever created over an existing one).
sharedPingDb.initializeAtStartup().catch((err) => {
    console.error('[pingDb] startup init error:', (err && err.message) ? err.message : err);
});

// Periodic database keep-alive: pings Supabase through the SAME pool the
// feature read/write paths use (`SELECT 1;`) once at startup, then every 72h,
// to stop free-tier databases from pausing idle connections. Fire-and-forget —
// a network hiccup can never delay/crash Discord login (see handlers/dbKeepAlive.js).
dbKeepAlive.start();

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
const loginPendingTimer = setTimeout(() => {
    if (!client.isReady()) {
        console.warn('[discord] login still pending after 30s');
    }
}, 30000);
loginPromise.then(() => {
    clearTimeout(loginPendingTimer);
    console.log('[discordAuth] Discord login OK.');
    // Arm the self-heal watchdog ONLY after a successful login: before READY the
    // "not ready" state is expected, and reconnecting during startup would just
    // burn Discord's identify budget.
    try { startGatewayWatchdog(client); } catch (err) { console.error('[gateway] could not arm self-heal watchdog:', (err && err.message) || err); }
}).catch(async (error) => {
    clearTimeout(loginPendingTimer);
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

    // Stop the database keep-alive timer so a pending check can't fire during
    // or after shutdown.
    try { dbKeepAlive.stop(); } catch (_) { /* ignore */ }

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
