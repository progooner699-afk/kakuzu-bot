'use strict';

/**
 * gatewayGuard.js - gateway lifecycle logging, SELF-HEAL watchdog + manual
 * reconnect helper.
 *
 * WHY THE WATCHDOG IS BACK (and why this one cannot repeat the old bug):
 * discord.js v14 auto-reconnects *recoverable* close codes. It cannot recover
 * from the two failures that actually bite a long-lived Render process:
 *   1. an unrecoverable close, or a boot login that never reaches READY - the
 *      library gives up and simply "will not reconnect"; and
 *   2. the shard staying nominally ready while the gateway goes stale.
 * In both cases the Express keep-alive keeps Render's badge green while the bot
 * ignores every slash command ("The application did not respond") - forever,
 * until a human restarts it. That is the exact "online but deaf for days"
 * failure this file exists to prevent.
 *
 * The version removed in 0b626e9 polled isReady() and called client.login()
 * unconditionally, so it fought Render's SIGTERM shutdown (destroy() looked like
 * a dead gateway -> login() during shutdown -> identify rate limits). This one:
 *   - is DISARMED inside markShuttingDown(), before anything destroys the
 *     client, so the shutdown race is structurally impossible;
 *   - never overlaps itself (single-flight tick + reconnectDiscord's own gate);
 *   - only acts after a grace period and at most once per minReconnectSpacingMs;
 *   - after maxReconnects per window it stops reconnecting and calls fatal()
 *     (process.exit(1)) so Render recycles the process with a fresh
 *     session_start_limit budget instead of sitting deaf forever.
 *
 * Security: no secrets are ever logged.
 */

const LOG_PREFIX = '[gateway]';
const CLIENT_STATE = new WeakMap();
/** Hard budget for the pre-reconnect REST liveness probe. */
const REST_PROBE_TIMEOUT_MS = 5000;

/** Tuning for the self-heal watchdog. Every field is overridable per client. */
const WATCHDOG_DEFAULTS = Object.freeze({
  intervalMs: 15 * 1000,           // health tick cadence (matches the ready.js loop)
  notReadyGraceMs: 45 * 1000,      // how long the gateway may be down before self-heal
  zombiePingMs: 30 * 1000,         // "ready but the socket is rotting" threshold
  zombieTicks: 3,                  // consecutive high-ping ticks before acting
  minReconnectSpacingMs: 60 * 1000, // never fight Discord's identify rate limit
  maxReconnects: 5,                // attempts allowed per window before giving up
  reconnectWindowMs: 10 * 60 * 1000,
});

function getState(client) {
  let s = CLIENT_STATE.get(client);
  if (!s) {
    s = {
      attached: false, isShuttingDown: false, connectedOnce: false, readyAt: null,
      lastError: null, reconnecting: false,
      startedAt: Date.now(), lastActivityAt: Date.now(), lastReadySeenAt: Date.now(),
      watchdogTimer: null, watchdogRunning: false, watchdogOpts: null,
      watchdogReconnects: 0, reconnectTimes: [], highPingTicks: 0,
      lastReconnectAt: 0, lastAction: 'none', lastReasons: [], fatalFired: false,
    };
    CLIENT_STATE.set(client, s);
  }
  return s;
}

function isReady(client) {
  return typeof client.isReady === 'function' ? Boolean(client.isReady()) : false;
}

/** Record "the gateway was demonstrably alive at this instant". Called from
 *  the interaction hub, so real traffic is always the freshest liveness proof. */
function markActivity(client) {
  if (!client) return;
  const s = getState(client);
  s.lastActivityAt = Date.now();
  if (isReady(client)) s.lastReadySeenAt = s.lastActivityAt;
}

function markShuttingDown(client) {
  const s = getState(client);
  s.isShuttingDown = true;
  // THE fix for the 0b626e9 race: the watchdog is disarmed here, BEFORE the
  // caller destroys the client, so it can never log back in during shutdown.
  stopGatewayWatchdog(client);
}



function attachGatewayGuard(client) {
  const s = getState(client);
  if (s.attached) return s;
  s.attached = true;

  client.on('error', (error) => {
    s.lastError = error;
    console.error(LOG_PREFIX + ' Discord client error (' + new Date().toISOString() + '):', error && error.stack || error);
  });

  client.on('warn', (info) => console.warn(LOG_PREFIX + ' Discord client warning (' + new Date().toISOString() + '):', info));

  client.on('shardError', (error, shardId) => {
    s.lastError = error;
    console.error(LOG_PREFIX + ' Shard ' + shardId + ' error (' + new Date().toISOString() + '):', error && error.stack || error);
  });

  client.on('shardDisconnect', (closeEvent, shardId) => {
    const code = closeEvent && closeEvent.code;
    console.warn(LOG_PREFIX + ' Shard ' + shardId + ' disconnected close code ' + code + ' (' + new Date().toISOString() + ').');
  });

  client.on('shardReconnecting', (shardId) => console.warn(LOG_PREFIX + ' Shard ' + shardId + ' reconnecting... (' + new Date().toISOString() + ')'));

  client.on('shardResume', (shardId, replayedEvents) => {
    markActivity(client);
    console.log(LOG_PREFIX + ' Shard ' + shardId + ' resumed (' + replayedEvents + ' replayed events, ' + new Date().toISOString() + ').');
  });

  client.on('shardReady', (shardId) => {
    s.connectedOnce = true;
    s.readyAt = Date.now();
    s.highPingTicks = 0;
    markActivity(client);
    console.log(LOG_PREFIX + ' Gateway shard ' + shardId + ' READY (' + new Date().toISOString() + ').');
  });

  client.on('invalidated', () => {
    console.warn(LOG_PREFIX + ' Discord session invalidated (' + new Date().toISOString() + ').');
  });

  return s;
}


async function reconnectDiscord(client, token = process.env.DISCORD_TOKEN) {
  const s = getState(client);

  if (s.isShuttingDown) {
    console.warn(LOG_PREFIX + ' Reconnect skipped: application is shutting down.');
    return false;
  }

  if (s.reconnecting) {
    console.warn(LOG_PREFIX + ' Reconnect already in progress - skipping duplicate request.');
    return false;
  }

  s.reconnecting = true;
  try {
    console.log(LOG_PREFIX + ' Reconnecting Discord client...');
    if (typeof client.destroy === 'function') {
      await client.destroy().catch(err => console.warn(LOG_PREFIX + ' destroy() failed (ignored):', err && err.message || err));
    }
    if (s.isShuttingDown) {
      console.warn(LOG_PREFIX + ' Reconnect aborted: application is shutting down.');
      return false;
    }
    if (!token) {
      throw new Error('DISCORD_TOKEN is missing or empty - cannot log in.');
    }
    await client.login(token);
    console.log(LOG_PREFIX + ' login() resolved (awaiting READY)..');
    return true;
  } catch (error) {
    s.lastError = error;
    console.error(LOG_PREFIX + ' Reconnect failed:', error && error.stack ? error.stack : error);
    return false;
  } finally {
    s.reconnecting = false;
  }
}


/** Cheap proof that the *credentials and network* still work, independent of
 *  the gateway socket. A dead gateway + healthy REST = a reconnect will help;
 *  a dead gateway + dead REST = reconnecting would only burn identify budget. */
async function probeRestGateway(client, timeoutMs = REST_PROBE_TIMEOUT_MS) {
  if (!client || !client.rest || typeof client.rest.get !== 'function') return true;
  try {
    await Promise.race([
      Promise.resolve(client.rest.get('/gateway/bot')),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('REST probe timeout after ' + timeoutMs + 'ms')), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    return true;
  } catch (err) {
    console.warn(LOG_PREFIX + ' REST probe failed (' + ((err && err.message) || err) + ') - reconnecting would not help yet.');
    return false;
  }
}

/**
 * Pure decision function for one watchdog tick (no side effects except the
 * rolling reconnect budget, which is why it takes `now`). Exported for tests.
 */
function evaluateGateway(client, opts = {}, now = Date.now()) {
  const s = getState(client);
  const o = Object.assign({}, WATCHDOG_DEFAULTS, s.watchdogOpts || {}, opts);
  const ready = isReady(client);
  const ping = (client && client.ws && typeof client.ws.ping === 'number') ? client.ws.ping : null;
  const downSince = ready ? 0 : Math.max(0, now - (s.lastReadySeenAt || s.startedAt || now));
  const out = {
    action: 'none', ready, ping, downSince,
    silentMs: Math.max(0, now - (s.lastActivityAt || now)),
    reasons: [],
  };

  // The two gates that make the old SIGTERM race impossible.
  if (s.isShuttingDown) { out.reasons.push('shutting-down'); return out; }
  if (s.reconnecting) { out.reasons.push('reconnect-in-progress'); return out; }

  let need = null;
  if (!ready) {
    if (downSince < o.notReadyGraceMs) { out.reasons.push('not-ready-grace:' + downSince + 'ms'); return out; }
    need = s.connectedOnce ? 'gateway-down:' + downSince + 'ms' : 'login-never-ready:' + downSince + 'ms';
  } else if (ping !== null && ping >= o.zombiePingMs) {
    if ((s.highPingTicks || 0) < o.zombieTicks) { out.reasons.push('high-ping:' + ping + 'ms'); return out; }
    need = 'gateway-stale:ping=' + ping + 'ms';
  }
  if (!need) { out.reasons.push('healthy'); return out; }

  const sinceLast = s.lastReconnectAt ? now - s.lastReconnectAt : Infinity;
  if (sinceLast < o.minReconnectSpacingMs) {
    out.action = 'wait';
    out.reasons.push(need + ' spacing:' + Math.round(sinceLast) + 'ms');
    return out;
  }
  s.reconnectTimes = (s.reconnectTimes || []).filter((t) => now - t < o.reconnectWindowMs);
  if (s.reconnectTimes.length >= o.maxReconnects) {
    out.action = 'fatal';
    out.reasons.push(need + ' budget-exhausted(' + s.reconnectTimes.length + '/' + o.maxReconnects + ')');
    return out;
  }
  out.action = 'reconnect';
  out.reasons.push(need);
  return out;
}

/** Run one self-heal tick: evaluate -> maybe reconnect -> maybe give up. */
async function runWatchdogTick(client, opts = {}, now = Date.now()) {
  const s = getState(client);
  if (s.isShuttingDown) return { action: 'none', reasons: ['shutting-down'] };

  if (isReady(client)) {
    s.lastReadySeenAt = now;
    const ping = (client && client.ws && typeof client.ws.ping === 'number') ? client.ws.ping : null;
    const o = Object.assign({}, WATCHDOG_DEFAULTS, s.watchdogOpts || {}, opts);
    s.highPingTicks = (ping !== null && ping >= o.zombiePingMs) ? (s.highPingTicks + 1) : 0;
  } else {
    s.highPingTicks = 0;
  }

  const verdict = evaluateGateway(client, opts, now);
  s.lastAction = verdict.action;
  s.lastReasons = verdict.reasons;

  if (verdict.action === 'reconnect') {
    if (!(await probeRestGateway(client, (s.watchdogOpts && s.watchdogOpts.restProbeTimeoutMs) || REST_PROBE_TIMEOUT_MS))) {
      return verdict; // gateway down AND REST down: hold, keep counting budget-free
    }
    if (s.isShuttingDown) return { action: 'none', reasons: ['shutting-down'] };
    s.reconnectTimes.push(now);
    s.lastReconnectAt = now;
    s.watchdogReconnects += 1;
    console.warn(LOG_PREFIX + ' SELF-HEAL: ' + verdict.reasons.join(' ') + ' - forcing a fresh gateway session (attempt ' + s.watchdogReconnects + ').');
    await reconnectDiscord(client);
  } else if (verdict.action === 'fatal') {
    s.fatalFired = true;
    const fatal = opts.fatal || (s.watchdogOpts && s.watchdogOpts.fatal) || null;
    console.error(LOG_PREFIX + ' SELF-HEAL GAVE UP (' + verdict.reasons.join(' ') + ') - exiting so the host recycles the process with a fresh session budget.');
    if (typeof fatal === 'function') { await fatal(verdict); } else { process.exit(1); }
  }
  return verdict;
}

/** Arm the self-heal watchdog. Idempotent; the interval is unref'd so it can
 *  never keep the process alive on its own. */
function startGatewayWatchdog(client, opts = {}) {
  const s = getState(client);
  s.watchdogOpts = Object.assign({}, s.watchdogOpts || {}, opts);
  if (s.watchdogTimer) return false;
  const intervalMs = s.watchdogOpts.intervalMs || WATCHDOG_DEFAULTS.intervalMs;
  s.watchdogTimer = setInterval(() => {
    if (s.watchdogRunning || s.isShuttingDown) return;
    s.watchdogRunning = true;
    Promise.resolve()
      .then(() => runWatchdogTick(client))
      .catch((err) => console.error(LOG_PREFIX + ' watchdog tick failed:', (err && err.stack) || err))
      .finally(() => { s.watchdogRunning = false; });
  }, intervalMs);
  if (typeof s.watchdogTimer.unref === 'function') s.watchdogTimer.unref();
  console.log(LOG_PREFIX + ' self-heal watchdog armed (tick ' + intervalMs + 'ms, grace ' + (s.watchdogOpts.notReadyGraceMs || WATCHDOG_DEFAULTS.notReadyGraceMs) + 'ms).');
  return true;
}

function stopGatewayWatchdog(client) {
  const s = getState(client);
  if (s.watchdogTimer) {
    clearInterval(s.watchdogTimer);
    s.watchdogTimer = null;
  }
}


function getGatewayDiagnostics(client) {
  const s = getState(client);
  const ready = isReady(client);
  const now = Date.now();
  return {
    status: ready ? 'Online' : (s.connectedOnce ? 'Offline' : 'NeverConnected'),
    connectedOnce: s.connectedOnce,
    shuttingDown: s.isShuttingDown,
    ping: client && client.ws ? client.ws.ping : undefined,
    readyAt: s.readyAt ? new Date(s.readyAt).toISOString() : null,
    lastError: s.lastError && s.lastError.message ? s.lastError.message : (s.lastError ? String(s.lastError) : null),
    uptimeMs: Math.max(0, process.uptime() * 1000),
    // Self-heal telemetry (counters/ids only - never secrets).
    silentForMs: Math.max(0, now - (s.lastActivityAt || now)),
    gatewayDownForMs: ready ? 0 : Math.max(0, now - (s.lastReadySeenAt || s.startedAt || now)),
    watchdog: {
      armed: Boolean(s.watchdogTimer),
      running: Boolean(s.watchdogRunning),
      reconnects: s.watchdogReconnects || 0,
      lastAction: s.lastAction || 'none',
      lastReasons: s.lastReasons || [],
      highPingTicks: s.highPingTicks || 0,
      gaveUp: Boolean(s.fatalFired),
    },
  };
}

module.exports = {
  attachGatewayGuard,
  reconnectDiscord,
  markShuttingDown,
  markActivity,
  getGatewayDiagnostics,
  evaluateGateway,
  runWatchdogTick,
  startGatewayWatchdog,
  stopGatewayWatchdog,
  probeRestGateway,
  WATCHDOG_DEFAULTS,
  REST_PROBE_TIMEOUT_MS,
};
