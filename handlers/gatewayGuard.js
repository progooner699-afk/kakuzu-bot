'use strict';

/**
 * gatewayGuard.js - keeps the Discord Gateway truly connected so Render's
 * "Live" badge (which only means the HTTP health endpoint returned 200)
 * can never silently lie about the bot's actual Discord status.
ot
 *
 * Why this exists:
 *  - Render classifies a web service as "Live" when its HTTP endpoint is up..
 *
 *
 *
 *    Nothing in that check touches Discord.. A boot-time login rejection
 *    (Discord session_start_limit 429 after repeated deploys/restarts,
 *    a transient 5xx from the Gateway REST endpoint, a bad/rotated token)
 *    used to be swallowed by this codebase's fire-and-forget client.login(),
 *    leaving the process running with the HTTP server up but ZERO Discord
 *    connection - "Live" but offline..
 *
 *  - discord.js v14 only auto-reconnects *recoverable* gateway close codes..
 *    When a shard hits an unrecoverable close(or the process was restarted
 *    and the new login never completed),the library marks the shard as
 *    `Disconnected` and emits `shardDisconnect` - "will no longer reconnect"..
 *    Without an external watchdog the bot stays offline silently forever..
 *
 * This guard:
 *   1. Logs every gateway lifecycle event (shardReady / shardResume /
 *      shardDisconnect / shardReconnecting / shardError / client error /
 *      invalidated / warn) WITH ISO timestamps, so Render logs explain
 *      exactly why a connection went down..
 *
 *   2. reconnectDiscord() - a single-flight destroy()+login() cycle that is
 *      reused by the dashboard /api/action/restart endpoint and the watchdog,
 *      so reconnect attempts never overlap each other or fight the library..
 *
 *   3. startGatewayWatchdog() - a bounded background loop: when the bot
 *      was previously connected but is now NOT ready for longer than a grace
 *      period(or a boot login never became ready), it forces a reconnect
 *      cycle.. Attempts are counted per window; once exceeded it invokes
 *      fatal(defaults to process.exit(1)) so Render recycles the whole
 *      service - a fresh process gets a fresh Discord session budget instead of
 *      sitting "Live" but offline forever..
 *
 * Security: no secrets are ever logged.. Only non-sensitive diagnostics
 * (ping, ready state, attempt counters, error *message*) are exposed..
 */

const LOG_PREFIX = '[gateway]';

// Default watchdog tuning (ms / counts).. Overridable via startGatewayWatchdog options..
const DEFAULT_WATCHDOG_OPTIONS = Object.freeze({
  intervalMs: 15 * 1000,   // how often the health tick runs
  graceMs:    45 * 1000,   // how long the bot may be down before we force a reconnect
  maxAttempts: 5,             // reconnect attempts permitted within one window
  windowMs:    10 * 60 * 1000, // reconnect-attempt accounting window
});

const CLIENT_STATE = new WeakMap();

function getState(client) {
  let s = CLIENT_STATE.get(client);
  if (!s) {
    s = {
      attached: false,
      connectedOnce: false,
      readyAt: null,
      startupStartedAt: Date.now(),
      reconnectAttempts: 0,
      reconnectWindowStartedAt: Date.now(),
      reconnecting: false,
      lastError: null,
      watchdogTimer: null,
      fatalFired: false,
    };
    CLIENT_STATE.set(client, s);
  }
  return s;
}

function isReady(client) {
  return typeof client.isReady === 'function' ? Boolean(client.isReady()) : false;
}

/**
 * Attaches gateway lifecycle loggers to a discord.js client.. Idempotent..
 *
 * The critical part: client.on('error', ...) MUST have a listener or Node
 * treats the emitted event as an uncaught throw (which this repo's
 * uncaughtException handler then swallows while leaving the connection dead)..
 * @param {object} client discord.js Client
 */
function attachGatewayGuard(client) {
  const s = getState(client);
  if (s.attached) return s;
  s.attached = true;

  client.on('error', (error) => {
    s.lastError = error;
    console.error(`${LOG_PREFIX} Discord client error (${new Date().toISOString()}):`, error && error.stack || error);
  });


  client.on('warn', (info) => console.warn(`${LOG_PREFIX} Discord client warning (${new Date().toISOString()}):`, info));


  client.on('shardError', (error, shardId) => {
    s.lastError = error;
    console.error(`${LOG_PREFIX} Shard ${shardId} error (${new Date().toISOString()}):`, error && error.stack || error);
  });


  client.on('shardDisconnect', (closeEvent, shardId) => {
    const code = closeEvent && closeEvent.code;
    console.warn(`${LOG_PREFIX} Shard ${shardId} disconnected close code ${code} (${new Date().toISOString()}) - discord.js will NOT auto-reconnect for unrecoverable codes; the watchdog will force a fresh login if this stays down.`);
  });


  client.on('shardReconnecting', (shardId) => console.warn(`${LOG_PREFIX} Shard ${shardId} reconnecting... (${new Date().toISOString()})`));


  client.on('shardResume', (shardId, replayedEvents) => console.log(`${LOG_PREFIX} Shard ${shardId} resumed (${replayedEvents} replayed events, ${new Date().toISOString()}).`));


  client.on('shardReady', (shardId) => {
    s.connectedOnce = true;
    s.readyAt = Date.now();
    s.reconnectAttempts =  0;
    s.reconnectWindowStartedAt = Date.now();
    console.log(`${LOG_PREFIX} Gateway shard ${shardId} READY (${new Date().toISOString()}).`);
  });


  // An invalidated session CANNOT be resumed - Discord demands a fresh
  // identify.. discord.js tears the WS down itself; give it a moment to
  // finish, then force a fresh login if the bot still isn't ready..
  client.on('invalidated', () => {
    console.warn(`${LOG_PREFIX} Discord session invalidated (${new Date().toISOString()}) - forcing a fresh re-login shortly.`);
    setTimeout(() => {
      if (!isReady(client) && !s.reconnecting) {
        console.warn(`${LOG_PREFIX} Still not ready after session invalidation - forcing reconnect.`);
        reconnectDiscord(client).catch(() => {});
      }
    }, 1500);
  });


  return s;
}
/**
 * Reconnects the Discord client with a single-flight destroy()+login() cycle..
 * Safe to call concurrently - only one cycle runs at a time; the others log
 * and return false immediately..
 * @param {object} client discord.js Client
 * @param {string} [token] Discord bot token (defaults to process.env.DISCORD_TOKEN)
 * @returns {Promise<boolean>} true if a reconnect cycle was started and completed ok,
 *   false if one was already in flight (or the cycle failed; call getGatewayDiagnostics
 *   for the lastError)..
 */
async function reconnectDiscord(client, token = process.env.DISCORD_TOKEN) {
  const s = getState(client);
  if (s.reconnecting) {
    console.warn(`${LOG_PREFIX} Reconnect already in progress - skipping duplicate request.`);
    return false;
  }



  s.reconnecting = true;
  s.reconnectAttempts +=  1;
  try {
    console.log(`${LOG_PREFIX} Reconnecting Discord client (attempt ${s.reconnectAttempts})...`);
    if (typeof client.destroy === 'function') {
      await client.destroy().catch(err => console.warn(`${LOG_PREFIX} destroy() failed (ignored):`, err && err.message || err));
    }
    if (!token) {
      throw new Error('DISCORD_TOKEN is missing or empty - cannot log in.');
    }
    await client.login(token);
    console.log(`${LOG_PREFIX} login() resolved (awaiting READY...)..`);
    return true;
  } catch (error) {
    s.lastError = error;
    console.error(`${LOG_PREFIX} Reconnect failed:`, error && error.stack ? error.stack : error);
    return false;
  } finally {
    s.reconnecting = false;
  }
}

function attemptsExhausted(s, cfg) {
  // Roll the accounting window: after windowMs has passed the counters reset,
  // so a long interruption only counts attempts actually made in the last window..
  if (Date.now() - s.reconnectWindowStartedAt > cfg.windowMs) {

    s.reconnectAttempts =  0;
    s.reconnectWindowStartedAt = Date.now();
  }
  return s.reconnectAttempts >= cfg.maxAttempts;
}

function tick(client, s, cfg, fatalFired) {

  if (s.reconnecting) return;
  if (s.fatalFired) return;





  if (isReady(client)) {
    // Healthy.. Reset attempt accounting - a fresh session is established..
    s.connectedOnce = true;
    s.readyAt = Date.now();
    s.reconnectAttempts =  0;
    s.reconnectWindowStartedAt = Date.now();
    return;
  }



  if (!s.connectedOnce) {

    // Boot path: we have never seen a successful connection.. The boot flow
    // in index.js owns the FIRST login and exits on failure - so this only
    // fires when that first login never became ready(hung network, half-dead
    // socket at boot).. A forced destroy+login unsticks it..
    if (Date.now() - s.startupStartedAt < cfg.graceMs) return;
    if (attemptsExhausted(s, cfg)) { s.fatalFired = true; return fatalFired(s, cfg); }
    reconnectDiscord(client, cfg.token).then(ok => { if (!ok) console.warn(`${LOG_PREFIX} Boot-path reconnect did not resolve ready (still not connected).`); }).catch(() => {});
    return;
  }




  // Was connected, now down(or reconnecting and never came back)..



  const downForMs = Date.now() - s.readyAt;  
  if (downForMs < cfg.graceMs) return;
  if (attemptsExhausted(s, cfg)) { s.fatalFired = true; return fatalFired(s, cfg); }
  reconnectDiscord(client, cfg.token).catch(() => {});
}

/**
 * Starts the gateway health watchdog for a client.. Idempotent - calling again
 * while one is running returns a stop handle for the EXISTING watchdog(and does
 * not double it)..
 *
 * Options (all optional): intervalMs, graceMs, maxAttempts, windowMs,
 * fatal (default process.exit(1)..
 *
 * @param {object} client discord.js Client
 * @param {object} [options] tuning overrides
 * @returns {() => void} stop() - clears the interval
 */
function startGatewayWatchdog(client, options = {}) {
  const s = getState(client)
  if (s.watchdogTimer) return () => stopGatewayWatchdog(client)

    const cfg = {
    ...DEFAULT_WATCHDOG_OPTIONS,
    token: process.env.DISCORD_TOKEN,
    ...options,
  };
  const fatalFired = typeof options.fatal === 'function'
    ? options.fatal
    : () => {
        console.error(`${LOG_PREFIX} FATAL: exceeded ${s.reconnectAttempts}/${cfg.maxAttempts} reconnect attempts without recovery (${new Date().toISOString()}) - exiting so the host recycles the service with a fresh Discord session budget.`);
        process.exit(1);
      };


  s.watchdogTimer = setInterval(() => {
    try {
      tick(client, s, cfg, fatalFired);
    } catch (error) {
      console.error(`${LOG_PREFIX} Watchdog tick error:`, error && error.stack ? error.stack : error);
    }
  }, cfg.intervalMs);


  // Run one tick immediately so a healthy client is registered as ready before
  // any downtime can be measured against an outdated readyAt..
  try {
    tick(client, s, cfg, fatalFired);
  } catch (error) {
    console.error(`${LOG_PREFIX} Watchdog initial tick error:`, error && error.stack ? error.stack : error);
  }

  return () => stopGatewayWatchdog(client)
}

/**
 * Stops the watchdog for a client(if running)..
 * @param {object} client discord.js Client
 */
function stopGatewayWatchdog(client) {
  const s = CLIENT_STATE.get(client)
  if (s && s.watchdogTimer) {
    clearInterval(s.watchdogTimer);
    s.watchdogTimer = null;
  }
}

/**
 * Real Discord-connection diagnostics for the dashboard API (NOT the Render
 * health check - this one actually reports whetherthe bot is online in Discord)..
 * @param {object} client discord.js Client
 * @returns {object} serializable snapshot (safe to expose over HTTP)
 */
function getGatewayDiagnostics(client) {
  const s = getState(client)
  const ready = isReady(client)
  // A ready client has necessarily connected at least once — derive the flag
  // from isReady() too so it is correct even before shardReady fires.
  const connectedOnce = ready || s.connectedOnce;
  return {
    status: ready ? 'Online' : (connectedOnce ? 'Offline' : 'NeverConnected'),
    connectedOnce: connectedOnce,
    ping: client && client.ws ? client.ws.ping : undefined,
    readyAt: s.readyAt ? new Date(s.readyAt).toISOString() : null,
    reconnecting: s.reconnecting,
    reconnectAttempts: s.reconnectAttempts,
    reconnectWindowStartedAt: s.reconnectWindowStartedAt ? new Date(s.reconnectWindowStartedAt).toISOString() : null,
    lastError: s.lastError && s.lastError.message ? s.lastError.message : (s.lastError ? String(s.lastError) : null),
    uptimeMs: Math.max(0, process.uptime() * 1000),
  };
}

module.exports = {
  attachGatewayGuard,
  startGatewayWatchdog,
  stopGatewayWatchdog,
  reconnectDiscord,
  getGatewayDiagnostics,
  DEFAULT_WATCHDOG_OPTIONS,
};