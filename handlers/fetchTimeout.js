'use strict';

/**
 * fetchTimeout.js — tiny timeout helpers for every network / database call.
 *
 * A hanging fetch / pg query with no deadline is the #1 way the bot can look
 * "running" on Render (HTTP 200) while Discord interactions silently time out:
 * the 15s presence loop piles up stuck promises and the modal handler blows
 * past Discord's 3-second ack window. Every helper here bounds a wait and
 * never logs secrets (only safe labels + ms).
 */

const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_DB_TIMEOUT_MS = 8000;

/**
 * Races any promise against a timer. The loser is ignored; the timer is
 * unref'd so it can never keep the process alive past shutdown.
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} [label] safe label for the error message (no secrets)
 */
function withTimeout(promise, ms, label) {
    const safeMs = Number(ms) > 0 ? Number(ms) : DEFAULT_DB_TIMEOUT_MS;
    const safeLabel = label || 'operation';
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${safeLabel} timed out after ${safeMs}ms`)), safeMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * fetch() with a hard AbortController deadline. Aborts the socket on timeout
 * so stuck Roblox / Supabase / geo calls can never hang the interaction
 * handler or the 15s presence loop forever.
 * @param {string} url
 * @param {object} [options] fetch options (signal, if given, is respected)
 * @param {number} [timeoutMs]
 */
async function fetchWithTimeout(url, options, timeoutMs) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => {
        try { controller.abort(); } catch (_) { /* ignore */ }
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
        const merged = Object.assign({}, options || {});
        if (merged.signal) {
            // Respect a caller-supplied signal too: abort when either fires.
            const callerSignal = merged.signal;
            delete merged.signal;
            if (callerSignal && callerSignal.aborted) controller.abort();
            else if (callerSignal && typeof callerSignal.addEventListener === 'function') {
                callerSignal.addEventListener('abort', () => {
                    try { controller.abort(); } catch (_) { /* ignore */ }
                }, { once: true });
            }
        }
        merged.signal = controller.signal;
        return await fetch(url, merged);
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw new Error(`fetch timed out after ${ms}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    withTimeout,
    fetchWithTimeout,
    DEFAULT_FETCH_TIMEOUT_MS,
    DEFAULT_DB_TIMEOUT_MS
};
