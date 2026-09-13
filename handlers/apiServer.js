'use strict';

/**
 * apiServer.js — Express app factory for the bot's HTTP dashboard API.
 *
 * A SINGLE Express app is created via createApiServer(client) and started
 * exactly once in index.js (no extra port / second HTTP server). Splitting the
 * app definition out of index.js lets the endpoints be unit-tested without
 * logging the bot into Discord or binding a fixed port.
 *
 * Routes:
 *   GET  /                       health check (Render badge)
 *   GET  /api/stats              live bot statistics (public dashboard)
 *   POST /api/action/restart     reconnect the Discord client (dashboard)
 *   GET  /api/health/discord     real gateway diagnostics (distinct from the
 *                                Render badge "Live" badge)
 *   GET  /api/guilds/:guildId/roles  bearer-protected selectable role list for
 *                                the dashboard's role pickers (45s response
 *                                cache + single-flight, never 429s)
 *
 * PING-MANAGEMENT REMOVAL: the dashboard's ping-settings page / endpoints
 * (country + region ping role CRUD against `guild_ping_settings`) were removed
 * — /pingsetup in Discord is the sole configuration path now. The generic
 * roles list endpoint above is NOT ping-management and was kept, along with
 * OAuth, server list, stats and every other dashboard feature.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { reconnectDiscord, getGatewayDiagnostics } = require('./gatewayGuard');

// Rolling-window rate limit helper (per client IP), 300/min.
// NOTE: not wired into any current route — kept as a reusable helper for any
// future PUBLIC endpoint where per-IP limiting makes sense.
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateLimitBuckets = new Map();

// Short, non-persistent in-memory response cache for the roles endpoint so that
// repeated identical dashboard loads are served without re-reading discord.js or
// risking a Discord REST call. Roles rarely change; 45s keeps them fresh enough.
const ROLE_CACHE_TTL_MS = 45 * 1000;
const roleResponseCache = new Map(); // guildId -> { roles, expiresAt } | { notFound, expiresAt }

// Unknown guilds are remembered briefly so a looping/rapid dashboard cannot
// re-hit Discord's REST API for the same non-member guild inside this window.
const GUILD_NOT_FOUND_TTL_MS = 10 * 1000;

// Single-flight map: concurrent cache-miss requests for the SAME guild share ONE
// guild/Discord read. This stops bursty dashboard traffic (StrictMode
// double-fetch, parallel warm instances, user double-clicks) from ever reaching
// Discord more than once at a time.
const roleFetchInflight = new Map(); // guildId -> Promise<{roles}|{statusCode,error}>

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
 * Rolling-window check for a client IP. Returns true when the request is within
 * budget, false when it should be rejected with 429.
 */
function consumeRateLimit(ip) {
    const now = Date.now();
    const bucket = rateLimitBuckets.get(ip) || [];
    const recent = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    if (recent.length >= RATE_LIMIT_MAX) {
        rateLimitBuckets.set(ip, recent);
        return false;
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

    return true;
}

/**
 * Express middleware form of the limiter (kept as a reusable helper).
 * Rejects with 429 when the IP is over budget.
 */
function rateLimit(req, res, next) {
    if (!consumeRateLimit(req.ip || 'unknown')) {
        return res.status(429).json({ error: 'RATE_LIMITED' });
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
 * Constant-time comparison of a received bearer token against BOT_API_TOKEN.
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
 * Resolves a guild's selectable roles for the dashboard. Called ONLY on a
 * response-cache miss and single-flighted (see getRolesOutcome), so at most one
 * of these runs per guild at any instant.
 *
 * Discord usage policy:
 *  - Guild: served from client.guilds.cache. A targeted guilds.fetch() is only a
 *    cold-start fallback and never repeats (single flight + notFound negative
 *    cache prevent re-hitting Discord for the same guild).
 *  - Roles: served from guild.roles.cache. guild.roles.fetch() is called ONLY
 *    when the role cache is genuinely unavailable (missing OR empty), exactly
 *    once, and never retried in a loop. discord.js's own REST queue absorbs
 *    Discord 429s internally, so no manual retry is needed or performed.
 *
 * @param {object} client discord.js Client
 * @param {string} guildId validated snowflake
 * @returns {Promise<{roles: object[]}|{statusCode: number, error: string}>}
 */
async function resolveGuildRoles(client, guildId) {
    let guild = client && client.guilds ? client.guilds.cache.get(guildId) : undefined;
    if (!guild && client && client.guilds && typeof client.guilds.fetch === 'function') {
        try {
            guild = await client.guilds.fetch(guildId).catch(() => null);
        } catch (err) {
            guild = null; // never surface internals - just not found
        }
    }
    if (!guild) {
        // Brief negative cache so repeated requests for the same unknown guild
        // never re-hit Discord's REST API inside this window.
        roleResponseCache.set(guildId, {
            notFound: true,
            expiresAt: Date.now() + GUILD_NOT_FOUND_TTL_MS
        });
        return { statusCode: 404, error: 'GUILD_NOT_FOUND' };
    }

    // Prefer discord.js cached role data. Fetch from the Discord REST API only
    // when the role cache is genuinely unavailable (missing or empty) - never on
    // every dashboard request, and at most once per cache miss.
    if (!guild.roles || !guild.roles.cache || guild.roles.cache.size === 0) {
        try {
            await guild.roles.fetch().catch(() => null);
        } catch (err) { /* keep whatever cache exists */ }
    }

    const allRoles = guild.roles && guild.roles.cache
        ? [...guild.roles.cache.values()]
        : [];
    if (allRoles.length === 0) {
        // A real Discord guild always has @everyone (id == guildId) at minimum,
        // so an empty result means the single role read failed/short-circuited.
        // Do NOT cache this outcome - the dashboard's Retry should re-attempt.
        return { statusCode: 503, error: 'ROLES_UNAVAILABLE' };
    }

    const selectableRoles = allRoles
        // The @everyone role shares the guild ID and can never be a selectable
        // target - exclude it entirely.
        .filter((role) => role.id !== guildId)
        // Managed/integration roles (owned by bots / connections) cannot
        // reasonably be assigned by the dashboard - exclude them.
        .filter((role) => !Boolean(role.managed))
        // Highest position first (Discord hierarchy order).
        .sort((a, b) => (b.position || 0) - (a.position || 0))
        .map((role) => serializeRole(role));

    // Cache the normalized response for the TTL so repeated identical loads never
    // re-read Discord. The result is considered immutable for its TTL.
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

    return { roles: selectableRoles };
}

/**
 * Cache-miss entry point with per-guild single-flight deduplication. The FIRST
 * concurrent miss for a guild becomes the leader: it performs at most one
 * Discord read and populates the response cache. Any request that arrives while
 * that work is in flight simply shares the leader's promise - no extra Discord
 * call and no duplicated work. Requests are NOT rate limited: every caller has
 * already authenticated with BOT_API_TOKEN, and the response cache +
 * single-flight + negative caching guarantee Discord is read at most once per
 * guild per TTL, so a normal authenticated dashboard load returns 200 on the
 * FIRST request and on every subsequent reload - never a 429.
 *
 * @param {object} client discord.js Client
 * @param {string} guildId validated snowflake
 * @returns {Promise<{roles: object[]}|{statusCode: number, error: string}>}
 */
function getRolesOutcome(client, guildId) {
    const inFlight = roleFetchInflight.get(guildId);
    if (inFlight) return inFlight;

    const pending = resolveGuildRoles(client, guildId).finally(() => {
        roleFetchInflight.delete(guildId);
    });

    roleFetchInflight.set(guildId, pending);
    return pending;
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

    // Health check (kept — Render badge + browser "is the HTTP server up").
    app.get('/', (req, res) => res.send('Kakuzu is Online!'));

    // Bot statistics endpoint (consumed by the React dashboard). Only aggregate
    // totals are exposed - never guild names/IDs, member IDs, usernames or secrets.
    app.get('/api/stats', (req, res) => {
        const guilds = client && client.guilds ? [...client.guilds.cache.values()] : [];
        const users = guilds.reduce(
            (sum, g) => sum + (Number.isInteger(g.memberCount) ? g.memberCount : 0),
            0
        );
        res.json({
            servers: guilds.length,
            users,
            ping: client && client.ws ? client.ws.ping : undefined,
            status: client && client.isReady ? (client.isReady() ? 'Online' : 'Offline') : 'Offline'
        });
    });

    // Restart/reconnect endpoint (consumed by the React dashboard).
    app.post('/api/action/restart', async (req, res) => {
        res.json({ success: true, message: 'Bot restarting...' });
        console.log('[API] Restart requested - reconnecting Discord client...');
        const ok = await reconnectDiscord(client);
        console.log(ok ? '[API] Bot reconnected successfully.' : '[API] Reconnect attempt finished but failed (see [gateway] logs).');
    });

    // Real Discord-connection diagnostics - distinct from the Render health
    // check: GET / returns 200 whenever the HTTP server is up, which is what
    // makes Render show "Live" even when the bot is offline in Discord. This
    // endpoint reports the ACTUAL gateway state so a browser can confirm real
    // connectivity instead of trusting the Render badge.
    app.get('/api/health/discord', (req, res) => {
        res.json(getGatewayDiagnostics(client));
    });

    // -------------------------------------------------------------------
    // Protected: selectable guild roles for the dashboard's role pickers.
    // Server-to-server ONLY. The dashboard FRONTEND must go through its own
    // backend which authenticates with BOT_API_TOKEN. (Ping-role configuration
    // itself moved to the /pingsetup Discord command, but this endpoint stays
    // for the dashboard's other guild settings — it is generic, not
    // ping-management.)
    //
    // 429 policy: requests are NEVER rejected with 429 here. Bearer-token auth
    // gates access; a 45s response cache, per-guild single-flight dedupe and an
    // unknown-guild negative cache cap bot-side Discord reads at one per guild
    // per TTL, so repeated/concurrent dashboard reloads cannot spam Discord and
    // a normal authenticated dashboard load returns 200 on the FIRST request.
    // -------------------------------------------------------------------
    app.get(
        '/api/guilds/:guildId/roles',
        authenticateApiToken,
        async (req, res) => {
            const { guildId } = req.params;

            // Temporary safe breadcrumb to detect dashboard request spam.
            countRoleApiRequest();

            if (!isValidSnowflake(guildId)) {
                return res.status(400).json({ error: 'INVALID_GUILD_ID' });
            }

            // Fast path: a still-fresh normalized response (or a briefly cached
            // unknown guild) is served immediately without touching discord.js
            // or the Discord REST API.
            const cachedResponse = roleResponseCache.get(guildId);
            if (cachedResponse && cachedResponse.expiresAt > Date.now()) {
                if (cachedResponse.notFound) {
                    return res.status(404).json({ error: 'GUILD_NOT_FOUND' });
                }
                return res.json({ guild_id: guildId, roles: cachedResponse.roles });
            }

            // Cache miss: single-flighted (at most one Discord read per
            // concurrent miss group for the same guild) and NOT rate limited -
            // bearer auth already gates access.
            const outcome = await getRolesOutcome(client, guildId);
            if (outcome.statusCode) {
                return res.status(outcome.statusCode).json({ error: outcome.error });
            }
            return res.json({ guild_id: guildId, roles: outcome.roles });
        }
    );

    return app;
}

module.exports = {
    createApiServer,
    verifyApiToken,
    authenticateApiToken,
    rateLimit,
    consumeRateLimit,
    isValidSnowflake,
    serializeRole
};