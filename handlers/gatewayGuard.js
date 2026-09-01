'use strict';

/**
 * gatewayGuard.js - gateway lifecycle logging + manual reconnect helper.
 *
 * discord.js v14 auto-reconnects recoverable close codes (network blips,
 * 5xx, 1000/1011). The old watchdog timer that polled isReady() and
 * called client.login() has been REMOVED: it raced with SIGTERM shutdown,
 * causing reconnect loops and Discord identify-rate-limit conflicts.
 *
 * Security: no secrets are ever logged.
 */

const LOG_PREFIX = '[gateway]';
const CLIENT_STATE = new WeakMap();

function getState(client) {
  let s = CLIENT_STATE.get(client);
  if (!s) {
    s = { attached: false, isShuttingDown: false, connectedOnce: false, readyAt: null, lastError: null, reconnecting: false };
    CLIENT_STATE.set(client, s);
  }
  return s;
}

function isReady(client) {
  return typeof client.isReady === 'function' ? Boolean(client.isReady()) : false;
}

function markShuttingDown(client) {
  const s = getState(client);
  s.isShuttingDown = true;
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

  client.on('shardResume', (shardId, replayedEvents) => console.log(LOG_PREFIX + ' Shard ' + shardId + ' resumed (' + replayedEvents + ' replayed events, ' + new Date().toISOString() + ').'));

  client.on('shardReady', (shardId) => {
    s.connectedOnce = true;
    s.readyAt = Date.now();
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


function getGatewayDiagnostics(client) {
  const s = getState(client);
  const ready = isReady(client);
  return {
    status: ready ? 'Online' : (s.connectedOnce ? 'Offline' : 'NeverConnected'),
    connectedOnce: s.connectedOnce,
    shuttingDown: s.isShuttingDown,
    ping: client && client.ws ? client.ws.ping : undefined,
    readyAt: s.readyAt ? new Date(s.readyAt).toISOString() : null,
    lastError: s.lastError && s.lastError.message ? s.lastError.message : (s.lastError ? String(s.lastError) : null),
    uptimeMs: Math.max(0, process.uptime() * 1000),
  };
}

module.exports = {
  attachGatewayGuard,
  reconnectDiscord,
  markShuttingDown,
  getGatewayDiagnostics,
};
