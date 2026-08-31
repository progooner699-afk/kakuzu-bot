const { registerGuildCommands, clearGlobalCommands } = require('../commands/deploy-commands');
const raidStateManager = require('../handlers/raidStateManager');
const autoJoinPresence = require('../handlers/autoJoinPresence');

/** How often (ms) to poll Roblox presence for active raid helpers. */
const PRESENCE_POLL_INTERVAL = 15 * 1000; // 15 seconds

// Retry schedule (ms) for guild slash-command registration. Discord's REST
// client already retries HTTP 429s; these extra retries cover the remaining
// transient failures (network blips, 5xx) so a single hiccup at startup can't
// leave a guild with NO working slash commands.
const REGISTRATION_RETRY_DELAYS_MS = [1000, 3000, 7000];

// Retry delay before the self-heal pass that re-registers commands in any
// guild that failed during startup.
const REGISTRATION_SELF_HEAL_DELAY_MS = 30 * 1000;

async function registerGuildCommandsWithRetry(guildId) {
    let lastError;
    for (const delay of REGISTRATION_RETRY_DELAYS_MS) {
        try {
            await registerGuildCommands(guildId);
            return;
        } catch (error) {
            lastError = error;
            console.warn(`⚠️ Command registration failed for guild ${guildId}, retrying in ${delay}ms:`, error?.message || error);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

module.exports = {
    name: 'clientReady',
    once: true,
    async execute(client) {
        console.log(`${client.user.tag} is online!`);

        // Register this bot's slash commands into every guild it is already a member of.
        // Doing this on startup means commands appear INSTANTLY in all current servers
        // (no manual deploy needed, and no global-command propagation delay).
        const guilds = [...client.guilds.cache.values()];
        if (guilds.length === 0) {
            console.log('⚡ Not in any servers yet — commands will register automatically when the bot joins a new server.');
            return;
        }

        console.log(`🔄 Registering slash commands in ${guilds.length} existing guild(s)...`);
        const results = await Promise.allSettled(guilds.map(g => registerGuildCommandsWithRetry(g.id)));
        let ok = 0;
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.error(`❌ Failed to register commands for ${guilds[i].name} (${guilds[i].id}):`, r.reason?.message || r.reason);
            } else {
                ok++;
            }
        });
        console.log(`✅ Commands registered in ${ok}/${guilds.length} guild(s).`);

        // De-dupe: guild + global commands BOTH registered makes Discord show
        // two copies of every command. Guild-scoped registration above is the
        // single source of truth, so wipe any global leftovers on startup.
        try {
            await clearGlobalCommands();
        } catch (err) {
            console.warn('⚠️ Could not clear global command duplicates:', (err && err.message) || err);
        }

        // Self-heal: re-register commands in any guild that failed above after a
        // short delay, so transient failures don't leave the bot command-less.
        const failedGuilds = guilds.filter((g, i) => results[i].status === 'rejected');
        if (failedGuilds.length > 0) {
            console.log(`🔁 Scheduling command registration self-heal for ${failedGuilds.length} guild(s)...`);
            setTimeout(async () => {
                const healResults = await Promise.allSettled(failedGuilds.map(g => registerGuildCommandsWithRetry(g.id)));
                const fixed = healResults.filter(r => r.status === 'fulfilled').length;
                console.log(`✅ Command registration self-heal complete: ${fixed}/${failedGuilds.length} guild(s) recovered.`);
            }, REGISTRATION_SELF_HEAL_DELAY_MS);
        }

        // Background helper time-tracking engine (Option B: Roblox Presence API polling).
        // Polls every 15s for helpers in active raids. If no ROBLOX_API_KEY is set,
        // pollHelperPresences silently no-ops and time is tracked via join-to-close delta.
        console.log('⏱️  Starting background helper time-tracking (presence polling)...');
        setInterval(async () => {
            try {
                const currentGuilds = [...client.guilds.cache.values()];
                await Promise.allSettled(currentGuilds.flatMap(g => [
                    // Helper time-tracking (presence deltas for existing helpers).
                    raidStateManager.pollHelperPresences(client, g.id),
                    // Presence-based AUTO-JOIN: linked users who are InGame in an
                    // open raid's experience are added to the LIVE HELPERS list.
                    autoJoinPresence.pollAutoJoin(client, g.id)
                ]));
            } catch (error) {
                console.warn('Presence polling loop error:', error?.message || error);
            }
        }, PRESENCE_POLL_INTERVAL);

        // Pre-initialize verification databases (sql.js wasm) so on-demand DB
        // queries during interaction handling do not hit the 3-second Discord
        // interaction timeout on first access.
        setTimeout(async () => {
            try {
                const verificationDb = require('../handlers/verificationDb');
                const guilds = [...client.guilds.cache.values()];
                await Promise.allSettled(
                    guilds.map(g => verificationDb.getVerificationData('__preload__', g.id).catch(() => null))
                );
                console.log('✅ Verification databases pre-initialized.');
            } catch (err) {
                console.warn('Verification DB pre-init failed:', err?.message || err);
            }
        }, 2000);
    },
};