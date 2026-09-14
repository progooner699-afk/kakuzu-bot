'use strict';

/**
 * dbKeepAlive.js — periodic liveness check for Kakuzu's shared Supabase /
 * PostgreSQL connection.
 *
 * Free/Supabase-tier databases can pause or drop idle connections. This module
 * runs `SELECT 1;` through the EXACT same pool that readFromDatabase() and
 * saveGuildPingSettings() use (sharedPingDb.runPoolQuery), so a successful
 * round-trip proves the feature read/write paths are genuinely talking to
 * Supabase and not silently serving in-memory data.
 *
 * Contract
 *   - One immediate check when start() is called.
 *   - On success: logs "[database-keepalive] Supabase is reachable" and
 *     schedules the next check 72h later.
 *   - On failure: logs a SANITIZED error (never the connection string /
 *     password), retries after 30 min. Never throws, never restarts the bot.
 *   - A single in-flight flag prevents overlapping checks.
 *   - stop() clears the timer and disarms the module for graceful shutdown.
 *   - No dummy records, tables, or fake activity are ever created.
 */

const sharedPingDb = require('./sharedPingDb');

const KEEPALIVE_SQL = 'SELECT 1;';
const QUERY_TIMEOUT_MS = 10000;            // requirement 6: 10s query timeout
const NORMAL_INTERVAL_MS = 72 * 60 * 60 * 1000;  // requirement 4: every 72 hours
const RETRY_INTERVAL_MS = 30 * 60 * 1000;  // requirement 8: retry 30 min after failure

let timer = null;       // handle for the pending scheduled check
let running = false;    // requirement 7: concurrency guard — only one check in-flight at a time
let started = false;    // requirement 7: makes start() idempotent — at most one check chain ever active
let stopped = false;     // set by stop() so a late fire after shutdown is ignored

function clearTimer() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}

/**
 * Schedules the next keep-alive tick. No-ops once stop() has been called so a
 * shutdown can't be undone by a race.
 * @param {number} delayMs
 */
function schedule(delayMs) {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(runOnce, delayMs);
    // Don't let a dangling timer keep the process alive past shutdown.
    if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * Performs a single keep-alive round-trip. Concurrency-guarded so a slow query
 * can't pile up overlapping checks.
 */
async function runOnce() {
    if (stopped || running) return;   // requirement 7: prevent overlapping jobs
    running = true;
    try {
        // runPoolQuery returns null when DATABASE_URL is unset (no pool) — not
        // an error, there is simply nothing to keep alive. Treat as a clean skip.
        const result = await sharedPingDb.runPoolQuery(KEEPALIVE_SQL, [], QUERY_TIMEOUT_MS);
        if (result === null) {
            console.log('[database-keepalive] DATABASE_URL not set — no database to keep alive.');
            return;
        }
        console.log('[database-keepalive] Supabase is reachable');   // requirement 3
        schedule(NORMAL_INTERVAL_MS);                                // requirement 4
    } catch (err) {
        // requirement 8: safe error (no URL/credentials), retry in 30 min, no crash
        console.warn('[database-keepalive] check failed:', sharedPingDb.sanitizeError(err));
        schedule(RETRY_INTERVAL_MS);
    } finally {
        running = false;
    }
}

/**
 * Starts the keep-alive: fires one check almost immediately (on next tick, so
 * startup is never blocked on the network) and then every 72 hours. If the
 * database isn't configured it logs that once and returns.
 */
function start() {
    if (stopped || started) return;   // idempotent: only one check chain per lifecycle (requirement 7)
    if (!sharedPingDb.isDatabaseConfigured()) {
        console.log('[database-keepalive] DATABASE_URL not set — keep-alive not started.');
        return;
    }
    started = true;
    // Fire immediately but asynchronously so startup is never blocked.
    setImmediate(() => !stopped && runOnce());
}

/**
 * Stops the keep-alive and clears any pending timer. Idempotent. Called from
 * index.js during graceful shutdown (requirement 9).
 */
function stop() {
    stopped = true;
    started = false;
    clearTimer();
}

module.exports = { start, stop };
