const { registerGuildCommands } = require('../commands/deploy-commands');
const raidStateManager = require('../handlers/raidStateManager');

/** How often (ms) to poll Roblox presence for active raid helpers. */
const PRESENCE_POLL_INTERVAL = 60 * 1000; // 60 seconds

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
        const results = await Promise.allSettled(guilds.map(g => registerGuildCommands(g.id)));
        let ok = 0;
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.error(`❌ Failed to register commands for ${guilds[i].name} (${guilds[i].id}):`, r.reason?.message || r.reason);
            } else {
                ok++;
            }
        });
        console.log(`✅ Commands registered in ${ok}/${guilds.length} guild(s).`);

        // Background helper time-tracking engine (Option B: Roblox Presence API polling).
        // Polls every 60s for helpers in active raids. If no ROBLOX_API_KEY is set,
        // pollHelperPresences silently no-ops and time is tracked via join-to-close delta.
        console.log('⏱️  Starting background helper time-tracking (presence polling)...');
        setInterval(async () => {
            try {
                const currentGuilds = [...client.guilds.cache.values()];
                await Promise.allSettled(currentGuilds.map(g => raidStateManager.pollHelperPresences(client, g.id)));
            } catch (error) {
                console.warn('Presence polling loop error:', error?.message || error);
            }
        }, PRESENCE_POLL_INTERVAL);
    },
};