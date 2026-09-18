'use strict';

/**
 * sharedPingDb.js — Tier-0 PostgreSQL access for guild country/region ping
 * settings (the `guild_ping_settings` table).
 *
 * BEHAVIOUR CONTRACT
 * ------------------------------------------------------------------
 * 1. PostgreSQL is the PERMANENT source of truth; the in-memory cache
 *    (`pingCache`) is a performance layer ONLY. Settings survive bot
 *    restarts, Render redeploys and cache clears because they live in
 *    Supabase PostgreSQL, never in a JS Map / JSON file / env var /
 *    Render filesystem.
 * 2. One reusable Pool, created lazily from DATABASE_URL, NEVER ended
 *    after queries, never hard-coded.
 * 3. The table is created idempotently (CREATE TABLE IF NOT EXISTS).
 *    Startup / deploy / command registration never DROPs or resets it,
 *    and never creates an empty row over an existing one.
 * 4. A temporary database failure never erases valid cached settings:
 *    cached config is returned until a write SUCCEEDS; a failed refresh
 *    keeps the previous cache entry instead of replacing it with empty.
 * 5. Errors are logged via sanitizeError() — the DATABASE_URL and
 *    password are NEVER printed.
 * 6. Saves are an UPSERT keyed on guild_id; updated_at is set to NOW().
 */

const { Pool } = require('pg');
const { withTimeout } = require('./fetchTimeout');

// Every Supabase round-trip is deadline-bounded: pg has no built-in query
// timeout here, so a stalled Supabase (paused project, network blackhole)
// resolves as a logged error instead of a promise that never settles and
// piles up inside the 15s presence loop.
const PING_QUERY_TIMEOUT_MS = 8000;

/**
 * The single dedicated settings table. Idempotent — never DROPs or
 * resets production data.
 */
const CREATE_TABLE_SQL = `\nCREATE TABLE IF NOT EXISTS guild_ping_settings (\n    guild_id TEXT PRIMARY KEY,\n    country_pings JSONB NOT NULL DEFAULT '{}'::jsonb,\n    region_pings JSONB NOT NULL DEFAULT '{}'::jsonb,\n    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n)\n`;

/**
 * Strips anything that could leak the connection string / credentials before
 * it is written to the log.
 * @param {*} error
 * @returns {string}
 */
function sanitizeError(error) {
    const raw = (error && error.message) || String(error);
    return raw
        .replace(/postgres(ql)?:\/\/[^\s"']*/gi, '[REDACTED_DATABASE_URL]')
        .replace(/password=[^\s"']*/gi, 'password=[REDACTED]')
        .replace(/(postgres(ql)?:\/\/)[^@]+@/gi, '$1[REDACTED_CREDENTIALS]@');
}

/**
 * Resolves the node-postgres `ssl` option from PGSSL or `?sslmode=` on the
 * connection URL (see AGENTS.md). Supabase requires TLS.
 * @param {string} [connectionString]
 * @returns {{rejectUnauthorized: boolean}|undefined}
 */
function resolveSslConfig(connectionString) {
    const override = (process.env.PGSSL || '').trim().toLowerCase();
    if (['require', 'no-verify', 'prefer', 'allow'].includes(override)) {
        return { rejectUnauthorized: false };
    }
    if (override === 'verify-full') return { rejectUnauthorized: true };
    if (['disable', 'false', 'none'].includes(override)) return undefined;

    const queryIndex = (connectionString || '').indexOf('?');
    if (queryIndex !== -1) {
        const params = new URLSearchParams((connectionString || '').slice(queryIndex + 1));
        const sslmode = (params.get('sslmode') || '').trim().toLowerCase();
        if (['require', 'no-verify', 'prefer', 'allow'].includes(sslmode)) {
            return { rejectUnauthorized: false };
        }
        if (sslmode === 'verify-full') return { rejectUnauthorized: true };
        if (sslmode === 'disable') return undefined;
    }
    return undefined;
}

let pool = null;
let warnedNoDatabaseUrl = false;

function isDatabaseConfigured() {
    const value = process.env.DATABASE_URL;
    return Boolean(value && String(value).trim().length > 0);
}

/**
 * Lazily builds the SINGLE connection pool. Returns null (no pool) when
 * DATABASE_URL is not configured, so the bot runs without a location ping.
 * Never calls pool.end() — one reusable pool for the process lifetime.
 * @returns {import('pg').Pool|null}
 */
function getPool() {
    if (pool) return pool;
    if (!isDatabaseConfigured()) {
        if (!warnedNoDatabaseUrl) {
            warnedNoDatabaseUrl = true;
            console.warn('[pingDb] DATABASE_URL is not set — guild ping settings will NOT be loaded. Set DATABASE_URL in the Render environment (never commit it).');
        }
        return null;
    }
    warnedNoDatabaseUrl = true;
    const connectionString = process.env.DATABASE_URL;
    const ssl = resolveSslConfig(connectionString);
    pool = new Pool(ssl ? { connectionString, ssl } : { connectionString });
    pool.on('error', (err) => {
        // Idle-client errors must never crash the bot process.
        console.warn('[pingDb] idle client error:', sanitizeError(err));
    });
    return pool;
}

let tableReadyPromise = null;

/**
 * Safe, one-time idempotent initialization. Retried lazily on failure without
 * ever DROPping or resetting the table.
 * @returns {Promise<boolean>} resolves true when the table is ready
 */
function ensureTableOnce() {
    if (!tableReadyPromise) {
        const currentPool = getPool();
        if (!currentPool) {
            tableReadyPromise = Promise.resolve(false);
        } else {
            tableReadyPromise = currentPool
                .query(CREATE_TABLE_SQL)
                .then(() => true)
                .catch((err) => {
                    console.warn('[pingDb] table init failed (will retry lazily):', sanitizeError(err));
                    tableReadyPromise = null; // allow a lazy retry on next call
                    return false;
                });
        }
    }
    return tableReadyPromise;
}

/* ---------------- in-memory cache (performance layer only) --------------- */

const pingCache = new Map(); // guildId -> { countryPings, regionPings }

function getCacheEntry(guildId) {
    const entry = pingCache.get(String(guildId || '').trim());
    return entry || null;
}

function setCacheEntry(guildId, countryPings, regionPings) {
    pingCache.set(String(guildId || '').trim(), {
        countryPings: { ...(countryPings || {}) },
        regionPings: { ...(regionPings || {}) }
    });
}

/** Number of guilds currently held in the in-memory cache (stats/health UI). */
function getCacheSize() {
    return pingCache.size;
}

/**
 * Normalizes an arbitrary JSONB value into a plain object of
 * `{ UPPERCASE_KEY: string }` entries. Filters unusable role ids
 * (empty / 0 / @everyone) so garbage can never reach the DB.
 * @param {*} value
 * @returns {object}
 */
function normalizeMap(value) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [key, raw] of Object.entries(value)) {
        const code = String(key || '').trim().toUpperCase();
        if (!code) continue;
        const roleId = String(raw === null || raw === undefined ? '' : raw).trim();
        if (!roleId || roleId === '0' || roleId === '@everyone') continue;
        out[code] = roleId;
    }
    return out;
}

/**
 * Coerces a JSONB cell (object or stringified JSON) into a plain object.
 * @param {*} value
 * @returns {object}
 */
function sanitizeJsonMap(value) {
    let parsed = value;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
}

/* ---------------- low-level database access ----------------------------- */

/**
 * Reads ONE guild's config from PostgreSQL. Returns null when the guild has
 * no row yet. Throws on real database errors (callers handle/cache safely).
 * @param {string} guildId
 * @returns {Promise<{countryPings: object, regionPings: object}|null>}
 */
async function readFromDatabase(guildId) {
    const currentPool = getPool();
    if (!currentPool) return null;
    await ensureTableOnce();
    const { rows } = await withTimeout(
        currentPool.query(
            'SELECT country_pings, region_pings FROM guild_ping_settings WHERE guild_id = $1',
            [String(guildId || '').trim()]
        ),
        PING_QUERY_TIMEOUT_MS,
        'ping settings read'
    );
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    return {
        countryPings: sanitizeJsonMap(row && row.country_pings),
        regionPings: sanitizeJsonMap(row && row.region_pings)
    };
}

/**
 * UPSERTs a guild's complete ping config. Never deletes the row first and
 * never touches other columns — `updated_at` is refreshed by PostgreSQL.
 * On success the in-memory cache is updated; on failure it is NOT touched
 * and the error is rethrown so the caller can show a truthful failure.
 * @param {string} guildId
 * @param {object} countryPings
 * @param {object} regionPings
 * @returns {Promise<{guildId: string, countryPings: object, regionPings: object}>}
 */
async function saveGuildPingSettings(guildId, countryPings, regionPings) {
    const gid = String(guildId || '').trim();
    const cp = normalizeMap(countryPings);
    const rp = normalizeMap(regionPings);
    const currentPool = getPool();
    if (!currentPool) {
        throw new Error('DATABASE_URL is not configured — ping settings cannot be saved.');
    }
    await ensureTableOnce();
    if (!tableReadyPromise) {
        throw new Error('Ping settings table is not available right now.');
    }
    await withTimeout(
        currentPool.query(
            `INSERT INTO guild_ping_settings (guild_id, country_pings, region_pings, updated_at)
             VALUES ($1, $2::jsonb, $3::jsonb, NOW())
             ON CONFLICT (guild_id)
             DO UPDATE SET country_pings = EXCLUDED.country_pings,
                           region_pings  = EXCLUDED.region_pings,
                           updated_at    = NOW()`,
            [gid, JSON.stringify(cp), JSON.stringify(rp)]
        ),
        PING_QUERY_TIMEOUT_MS,
        'ping settings save'
    );
    setCacheEntry(gid, cp, rp);
    return { guildId: gid, countryPings: cp, regionPings: rp };
}

/**
 * Loads EVERY guild config from PostgreSQL into the cache. Never clears the
 * existing cache on failure and never inserts empty rows over existing ones.
 * @returns {Promise<number>} number of configs loaded
 */
async function loadAllSettingsIntoCache() {
    if (!isDatabaseConfigured()) {
        console.warn('[pingDb] startup preload skipped — DATABASE_URL is not set.');
        return 0;
    }
    const currentPool = getPool();
    if (!currentPool) return 0;
    try {
        await ensureTableOnce();
        const { rows } = await withTimeout(
            currentPool.query(
                'SELECT guild_id, country_pings, region_pings FROM guild_ping_settings'
            ),
            PING_QUERY_TIMEOUT_MS,
            'ping settings preload'
        );
        let loaded = 0;
        for (const row of rows || []) {
            if (!row || !row.guild_id) continue;
            setCacheEntry(row.guild_id, sanitizeJsonMap(row.country_pings), sanitizeJsonMap(row.region_pings));
            loaded += 1;
        }
        return loaded;
    } catch (err) {
        console.warn('[pingDb] startup preload failed:', sanitizeError(err));
        return 0;
    }
}

/* ---------------- public API (cache-first) ------------------------------- */

/**
 * Returns a guild's ping settings: cache first, database on a cache miss.
 * NEVER throws. NEVER replaces a valid cache entry with an empty config
 * when a query fails — on failure the last known cache entry wins.
 *
 * @param {string} guildId - Discord guild ID
 * @returns {Promise<{countryPings: object, regionPings: object}>}
 */
async function getGuildPingSettings(guildId) {
    const gid = String(guildId || '').trim();
    const cached = getCacheEntry(gid);
    if (cached) return { countryPings: cached.countryPings, regionPings: cached.regionPings };
    if (!gid) return { countryPings: {}, regionPings: {} };

    try {
        const config = await readFromDatabase(gid);
        if (config) {
            // Cache ONLY a successful read of an existing row — never an
            // empty/failed result, so a DB blip can't poison the cache.
            setCacheEntry(gid, config.countryPings, config.regionPings);
            return { countryPings: config.countryPings, regionPings: config.regionPings };
        }
        return { countryPings: {}, regionPings: {} };
    } catch (err) {
        console.warn('[pingDb] getGuildPingSettings failed (cache NOT cleared):', sanitizeError(err));
        return { countryPings: {}, regionPings: {} };
    }
}

/**
 * Forces a fresh database read for one guild into the cache (used when an
 * admin opens the /pingsetup builder so the newest saved state is shown).
 * If the database is unavailable the previous cache entry is retained.
 * @param {string} guildId
 * @returns {Promise<{countryPings: object, regionPings: object}>}
 */
async function refreshGuildSettingsCache(guildId) {
    const gid = String(guildId || '').trim();
    try {
        const config = await readFromDatabase(gid);
        if (config) {
            setCacheEntry(gid, config.countryPings, config.regionPings);
            return { countryPings: config.countryPings, regionPings: config.regionPings };
        }
        return { countryPings: {}, regionPings: {} };
    } catch (err) {
        console.warn('[pingDb] refresh failed (keeping cached settings):', sanitizeError(err));
        const cached = getCacheEntry(gid);
        return cached
            ? { countryPings: cached.countryPings, regionPings: cached.regionPings }
            : { countryPings: {}, regionPings: {} };
    }
}

const HEALTH_TIMEOUT_MS = 8000;

function dbHealthCheckTimeout(promise, ms) {
    const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Database health check timed out after ${ms}ms`)), ms);
        timer.unref && timer.unref();
    });
    return Promise.race([promise, timeout]);
}

/**
 * Runs a query on the SHARED connection pool (the same one used by
 * readFromDatabase / saveGuildPingSettings) with a timeout. Returns the pg
 * query result on success, or null when no pool is available (DATABASE_URL not
 * set) so callers can no-op. Throws on a real query error or timeout.
 *
 * Because this uses the very same pool as the feature read/write paths, a
 * successful round-trip here is proof that normal Kakuzu features are actually
 * reading and writing Supabase instead of silently using in-memory data.
 * @param {string} sql
 * @param {array} [params]
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>}
 */
async function runPoolQuery(sql, params = [], timeoutMs = 10000) {
    const currentPool = getPool();
    if (!currentPool) return null;
    return dbHealthCheckTimeout(currentPool.query(sql, params), timeoutMs);
}

/**
 * Database health check used at startup and by the builder status line.
 * Never throws; logs the real SANITIZED error on failure.
 * @returns {Promise<{ok: boolean, configured: boolean, detail?: string}>}
 */
async function checkDatabaseHealth() {
    if (!isDatabaseConfigured()) {
        return { ok: false, configured: false, detail: 'DATABASE_URL is not set in the environment.' };
    }
    const currentPool = getPool();
    if (!currentPool) return { ok: false, configured: true, detail: 'Pool could not be created.' };
    try {
        await dbHealthCheckTimeout(currentPool.query('SELECT 1 AS ok'), HEALTH_TIMEOUT_MS);
        await ensureTableOnce();
        return { ok: true, configured: true, detail: undefined };
    } catch (err) {
        const detail = sanitizeError(err);
        console.warn('[pingDb] health check FAILED:', detail);
        return { ok: false, configured: true, detail };
    }
}

/**
 * Startup hook: connect, run a real health check, then preload every saved
 * guild config into the cache. Non-blocking design (fire-and-forget) so a
 * slow or down database never delays Discord login.
 * @returns {Promise<{ok: boolean, loaded: number, ms: number}>}
 */
async function initializeAtStartup() {
    const started = Date.now();
    const health = await checkDatabaseHealth();
    if (!health.ok) {
        if (health.configured) {
            console.error('[pingDb] ❌ Database health check FAILED at startup —', health.detail);
        } else {
            console.warn('[pingDb] ⚠️', health.detail, 'Ping settings will load as soon as DATABASE_URL is set (Render env).');
        }
        return { ok: false, loaded: 0, ms: Date.now() - started };
    }
    const loaded = await loadAllSettingsIntoCache();
    console.log(`[pingDb] ✅ Database connected. Loaded ${loaded} guild ping configuration(s) into cache in ${Date.now() - started}ms.`);
    return { ok: true, loaded, ms: Date.now() - started };
}

module.exports = {
    getGuildPingSettings,
    refreshGuildSettingsCache,
    saveGuildPingSettings,
    runPoolQuery,
    loadAllSettingsIntoCache,
    checkDatabaseHealth,
    initializeAtStartup,
    isDatabaseConfigured,
    sanitizeError,
    _getCacheSize: getCacheSize
};