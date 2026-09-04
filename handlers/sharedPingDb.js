'use strict';

/**
 * sharedPingDb.js - Tier-0 shared PostgreSQL access for the
 * dashboard -> bot raid ping configuration.
 *
 * Scope (intentionally tiny and isolated):
 *   o Reads ONLY the country + region role-ping mappings that the separately
 *     deployed dashboard writes to PostgreSQL.
 *   o Uses only the DATABASE_URL environment variable - never a hard-coded
 *     connection string.
 *   o Parameterized SQL only; never logs DATABASE_URL.
 *   o Never crashes a raid: every function degrades to
 *     `{ countryPings: {}, regionPings: {} }` so the bot simply posts with no
 *     location ping (the legacy /setregionping settings.json config was removed).
 *
 * NOTHING ELSE is migrated here. raids.json, settings.json, verification.sqlite
 * and leaderboard.sqlite are left completely untouched.
 */

const { Pool } = require('pg');

/**
 * The single table dedicated to dashboard-owned guild ping settings.
 * Idempotent (CREATE TABLE IF NOT EXISTS) - the bot never DROPs or resets
 * production data.
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
        .replace(/password=[^\s"']*/gi, 'password=[REDACTED]');
}

/**
 * Resolves the node-postgres `ssl` option.
 *
 * Order of precedence:
 *   1. PGSSL env var override (require | no-verify | prefer | allow |
 *      verify-full | disable/false/none).
 *   2. `sslmode=` query parameter on DATABASE_URL (typical for hosted
 *      providers - they append `?sslmode=require` or `?sslmode=no-verify`).
 *
 * Hosted providers almost always require TLS; `rejectUnauthorized:false` is
 * used for the common require / no-verify / prefer modes (self-signed certs).
 * Use `sslmode=verify-full` for certified endpoints.
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

/**
 * Lazily builds the connection pool. Returns null (no pool) when DATABASE_URL
 * is not configured, so the bot runs fine entirely offline from Postgres.
 * @returns {import('pg').Pool|null}
 */
function getPool() {
    if (pool) return pool;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        // One-time diagnostic so admins immediately see why dashboard pings
        // never appear instead of silently getting empty config.
        if (!warnedNoDatabaseUrl) {
            warnedNoDatabaseUrl = true;
            console.warn('[sharedPingDb] DATABASE_URL is not set — dashboard raid pings will NOT be loaded. Set DATABASE_URL in your environment (see .env template).');
        }
        return null; // shared DB not configured -> no location ping (legacy /setregionping removed)
    }
    warnedNoDatabaseUrl = true; // connection string present — suppress the warning
    const ssl = resolveSslConfig(connectionString);
    pool = new Pool(ssl ? { connectionString, ssl } : { connectionString });
    pool.on('error', (err) => {
        // Idle-client errors must never crash the bot process.
        console.warn('[sharedPingDb] idle client error:', sanitizeError(err));
    });
    return pool;
}

let tableReadyPromise = null;

/**
 * Safe, one-time idempotent initialization. Retried lazily on failure without
 * ever DROPping or resetting the table.
 * @returns {Promise<boolean>}
 */
function ensureTableOnce() {
    if (!tableReadyPromise) {
        const currentPool = getPool();
        if (!currentPool) {
            tableReadyPromise = Promise.resolve(false);
            return tableReadyPromise;
        }
        tableReadyPromise = currentPool
            .query(CREATE_TABLE_SQL)
            .then(() => true)
            .catch((err) => {
                console.warn('[sharedPingDb] table init failed (will retry lazily):', sanitizeError(err));
                tableReadyPromise = null; // allow a lazy retry on next call
                return false;
            });
    }
    return tableReadyPromise;
}

/**
 * Fetches a guild's ping settings from the shared PostgreSQL database.
 * @param {string} guildId - Discord guild ID (kept as text)
 * @returns {Promise<{countryPings: object, regionPings: object}>}
 *   Always resolves. Never throws. Empty mappings when there is no record,
 *   when DATABASE_URL is unset, or when the database is temporarily down.
 */
async function getGuildPingSettings(guildId) {
    const currentPool = getPool();
    if (!currentPool) return { countryPings: {}, regionPings: {} };

    try {
        await ensureTableOnce();
        const { rows } = await currentPool.query(
            'SELECT country_pings, region_pings FROM guild_ping_settings WHERE guild_id = $1',
            [String(guildId || '').trim()]
        );
        if (!rows || rows.length === 0) {
            console.warn('[sharedPingDb] No ping settings row for guild', guildId, '— has the dashboard saved a config for this guild?');
            return { countryPings: {}, regionPings: {} };
        }

        const row = rows[0];
        const countryPings = (row && row.country_pings && typeof row.country_pings === 'object') ? row.country_pings : {};
        const regionPings = (row && row.region_pings && typeof row.region_pings === 'object') ? row.region_pings : {};

        // Diagnostic: log the raw keys so case mismatches are immediately visible.
        console.log(
            '[sharedPingDb] Loaded ping config for guild', guildId,
            '| country keys:', Object.keys(countryPings),
            '| region keys:', Object.keys(regionPings)
        );

        return { countryPings, regionPings };
    } catch (err) {
        // Database temporarily unavailable - fail safe, never crash the raid.
        console.warn('[sharedPingDb] getGuildPingSettings failed:', sanitizeError(err));
        return { countryPings: {}, regionPings: {} };
    }
}

module.exports = { getGuildPingSettings };
