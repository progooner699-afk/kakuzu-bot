'use strict';

/**
 * apiServer.js - Express app factory for the bot's HTTP dashboard API.
 *
 * A SINGLE Express app is created via createApiServer(client) and started
 * exactly once in index.js (no extra port / second HTTP server). Splitting the
 * app definition out of index.js lets the endpoints be unit-tested without
 * logging the bot into Discord or binding a fixed port.
 *
 * Routes:
 *   GET  /                          health check
 *   GET  /api/stats                 live bot statistics (public dashboard)
 *   POST /api/action/restart        reconnect the Discord client (dashboard)
 *   GET  /api/guilds/:guildId/roles protected: selectable guild roles
 *                                   (server-to-server; requires
 *                                    `Authorization: Bearer BOT_API_TOKEN`)
 *
 * Security notes:
 *   - BOT_API_TOKEN is read from the environment at request time and compared
 *     with a constant-time comparison. It is never logged, never returned in a
 *     response, and never sent to Discord.
 *   - The roles endpoint is deliberately NOT exposed to arbitrary browser
 *     origins: it uses bearer auth only. The dashboard FRONTEND must call its
 *     own backend, which calls this endpoint server-to-server.
 *   - A small in-memory rate limit protects the roles endpoint, and a short
 *     TTL response cache means repeated identical loads never hit Discord.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// Simple rolling-window rate limit for the protected endpoint (per client IP).
// This is an AUTHENTICATED server-to-server route (BOT_API_TOKEN) whose requests
// come from the dashboard backend's small set of shared egress IPs. The window
// is generous enough for normal dashboard use (multiple selectors/refreshes per
// load) yet still cuts off runaway/abusive loops.
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateLimitBuckets = new Map();

// Short, non-persistent in-memory response cache for the roles endpoint so that
// repeated identical dashboard loads are served without re-reading discord.js or
// risking a Discord REST call. Roles rarely change; 45s keeps them fresh enough.
const ROLE_CACHE_TTL_MS = 45 * 1000;
const roleResponseCache = new Map(); // guildId -> { roles, expiresAt }

// Temporary, safe breadcrumb to detect dashboard request spam. Counts only a
// small hit-count + the route path - never auth headers/tokens, never bodies.
const roleApiBurst = { start: Date.now(), count: 0 };
const ROLE_API_BURST_WINDOW_MS = 10 * 1000;
const ROLE_API_BURST_LOG_AT = 20; // log when >20 hits land inside one 10s window
function countRoleApiRequest() {
    const now = Date.now();
    if (now - roleApiBurst.start >= ROLE_API_BURST_WINDOW_MS) {
        if (roleApiBurst.count >= ROLE_API_BURST_LOG_AT) {
            console.log(`[API] role selector got ${roleApiBurst.count} requests in a 10s window (path /api/guilds/:guildId/roles)`);
        }
        roleApiBurst.start = now;
        roleApiBurst.count = 0;
    }
    roleApiBurst.count += 1;
}

/**
 * Constant-time comparison of the received bearer token against BOT_API_TOKEN.
 * Returns false when the env var is unset or the token is wrong/empty.
 * Never throws and never logs either value.
 * @param {string} received
 * @returns {boolean}
 */
function verifyApiToken(received) {
    const expected = process.env.BOT_API_TOKEN;
    if (!expected || !received) return false;
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(received));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Express middleware: requires `Authorization: Bearer <BOT_API_TOKEN>`.
 * Missing or incorrect token -> 401 UNAUTHORIZED.
 */
function authenticateApiToken(req, res, next) {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const received = match ? match[1].trim() : '';
    if (!verifyApiToken(received)) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    next();
}

/**
 * Minimal per-IP rolling-window limiter. Rejects with 429 when exceeded.
 */
function rateLimit(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const bucket = rateLimitBuckets.get(ip) || [];
    const recent = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    if (recent.length >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'RATE_LIMITED' });
    }

    recent.push(now);
    rateLimitBuckets.set(ip, recent);

    // Opportunistic cleanup so the map never grows unbounded.
    if (rateLimitBuckets.size > 1000) {
        for (const [key, stamps] of rateLimitBuckets) {
            if (!stamps.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) {
                rateLimitBuckets.delete(key);
            }
        }
    }

    next();
}

// Discord snowflakes are unsigned 64-bit integers serialized as decimal
// strings; realistic IDs are 17-20 digits.
const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Validates that a guildId looks like a Discord snowflake.
 * @param {string} guildId
 * @returns {boolean}
 */
function isValidSnowflake(guildId) {
    return SNOWFLAKE_RE.test(String(guildId || ''));
}

/**
 * Projects a Discord role into the minimal shape the dashboard needs.
 * Only these fields are ever returned - never full Discord Role objects.
 * @param {object} role
 * @returns {object}
 */
function serializeRole(role) {
    return {
        id: role.id,
        name: role.name || '',
        color: typeof role.color === 'number' ? role.color : 0,
        position: typeof role.position === 'number' ? role.position : 0,
        mentionable: Boolean(role.mentionable),
        managed: Boolean(role.managed)
    };
}

/**
 * Builds the bot's SINGLE HTTP API application. `client` is the discord.js
 * Client instance. index.js is the only place that calls app.listen().
 * @param {import('discord.js').Client} client
 * @returns {import('express').Express}
 */
function createApiServer(client) {
    const app = express();

    // Allow the existing local dashboard frontend + JSON request bodies.
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
        console.log('[API] Restart requested - reconnecting Discord client...');
        try {
            await client.destroy();
            await client.login(process.env.DISCORD_TOKEN);
            console.log('[API] Bot reconnected successfully.');
        } catch (error) {
            console.error('[API] Restart failed:', error);
        }
    });

    // -------------------------------------------------------------------
    // Protected: selectable guild roles for the dashboard ping setup.
    // Server-to-server ONLY. The dashboard FRONTEND must go through its own
    // backend (Netlify function) which authenticates with BOT_API_TOKEN.
    // -------------------------------------------------------------------
    app.get(
        '/api/guilds/:guildId/roles',
        authenticateApiToken,
        rateLimit,
        async (req, res) => {
            const { guildId } = req.params;

            // Temporary safe breadcrumb to detect dashboard request spam.
            countRoleApiRequest();

            if (!isValidSnowflake(guildId)) {
                return res.status(400).json({ error: 'INVALID_GUILD_ID' });
            }

            // Fast path: a still-fresh normalized response is cached, so serve it
            // immediately without touching discord.js or the Discord REST API.
            const cachedResponse = roleResponseCache.get(guildId);
            if (cachedResponse && cachedResponse.expiresAt > Date.now()) {
                return res.json({ guild_id: guildId, roles: cachedResponse.roles });
            }

            // Only guilds the bot actually belongs to may be queried. Cache
            // first; a targeted fetch is used only when the guild is not in
            // cache (fetch rejects for unknown guilds -> GUILD_NOT_FOUND).
            let guild = client && client.guilds ? client.guilds.cache.get(guildId) : undefined;
            if (!guild && client && client.guilds && typeof client.guilds.fetch === 'function') {
                try {
                    guild = await client.guilds.fetch(guildId).catch(() => null);
                } catch (err) {
                    guild = null; // never surface internals - just not found
                }
            }
            if (!guild) {
                return res.status(404).json({ error: 'GUILD_NOT_FOUND' });
            }

            // Prefer discord.js cached role data for a guild the bot is connected
            // to. Only fetch from the Discord REST API when the role cache is
            // genuinely missing/partial (rare) - never on every dashboard request.
            if (!guild.roles || !guild.roles.cache) {
                try {
                    await guild.roles.fetch().catch(() => null);
                } catch (err) { /* keep whatever cache exists */ }
            }
            const roles = (guild.roles && guild.roles.cache)
                ? [...guild.roles.cache.values()]
                : [];

            const selectableRoles = roles
                // The @everyone role shares the guild ID and can never be a
                // raid-ping target - exclude it entirely.
                .filter((role) => role.id !== guildId)
                // Managed/integration roles (owned by bots / connections)
                // cannot reasonably be assigned as raid pings - exclude them.
                .filter((role) => !Boolean(role.managed))
                // Highest position first (Discord hierarchy order).
                .sort((a, b) => (b.position || 0) - (a.position || 0))
                .map((role) => serializeRole(role));

            // Cache the normalized response for the TTL so repeated identical loads
            // never re-read Discord. Result is considered immutable for its TTL.
            roleResponseCache.set(guildId, {
                roles: selectableRoles,
                expiresAt: Date.now() + ROLE_CACHE_TTL_MS
            });

            // Opportunistic cleanup so the cache never grows unbounded.
            if (roleResponseCache.size > 1000) {
                for (const [key, entry] of roleResponseCache) {
                    if (entry.expiresAt <= Date.now()) roleResponseCache.delete(key);
                }
            }

            return res.json({ guild_id: guildId, roles: selectableRoles });
        }
    );

    return app;
}

module.exports = {
    createApiServer,
    verifyApiToken,
    authenticateApiToken,
    rateLimit,
    isValidSnowflake,
    serializeRole
};
