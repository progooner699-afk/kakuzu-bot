const test = require('node:test');
const assert = require('assert');

const {
  attachGatewayGuard,
  startGatewayWatchdog,
  stopGatewayWatchdog,
  reconnectDiscord,
  getGatewayDiagnostics,
} = require('../handlers/gatewayGuard');

function makeClient() {
  const listeners = new Map();
  let readyState = true;
  const client = {
    destroyedCalls: 0,
    loginCalls: 0,
    ws: { ping: 42 },
    isReady: () => readyState,
    destroy: async () => {
      client.destroyedCalls += 1;
      readyState = false;
    },
    login: async () => {
      client.loginCalls += 1;
    },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit: (event ,...args) => {
      (listeners.get(event) || []).forEach((fn) => fn(...args));
    },
    _setReady: (v) => { readyState = v; },
    _listeners: listeners,
  };
  return client;
}

test('attachGatewayGuard registers an error listener (so error events never throw)', () => {
  const client = makeClient();
  attachGatewayGuard(client);
  assert.strictEqual(client._listeners.has('error'), true);
  assert.doesNotThrow(() => client.emit('error', new Error('boom')));
});

test('reconnectDiscord is single-flight: destroy + login happen exactly once', async () => {
  const client = makeClient();
  attachGatewayGuard(client);
    const results = await Promise.all([reconnectDiscord(client, 'test-token'), reconnectDiscord(client, 'test-token')]);
  assert.strictEqual(client.destroyedCalls, 1);
  assert.strictEqual(client.loginCalls, 1);
  assert.deepStrictEqual(results, [true, false]);
});

test('watchdog reconnects after grace, fires fatal exactly once', async () => {
  const client = makeClient();
  attachGatewayGuard(client);
  let fatals = 0;
    const stop = startGatewayWatchdog(client, {
    intervalMs: 10,
    graceMs: 10,
    maxAttempts: 2,
    windowMs:  5000,
    token: 'test-token',
    fatal: () => { fatals += 1; },
  });
  try {
    client._setReady(false); // the connection drops
    await new Promise(r => setTimeout(r, 80));
    assert.ok(client.loginCalls >= 2, 'watchdog should force reconnect attempts');
    assert.strictEqual(fatals, 1, 'fatal fires exactly once (guard flag stops repeats)');
  } finally {
    stop();
  }
});

test('watchdog stays idle while the client is healthy', async () => {
  const client = makeClient();
  attachGatewayGuard(client);
  const stop = startGatewayWatchdog(client, { intervalMs: 10, graceMs: 10, fatal: () => {} });
  try {
    await new Promise(r => setTimeout(r, 35));
    assert.strictEqual(client.loginCalls, 0, 'no forced reconnects while healthy');
  } finally {
    stop();
  }
});

test('getGatewayDiagnostics reports ready state and ping', () => {
  const client = makeClient();
  attachGatewayGuard(client);
  const diag = getGatewayDiagnostics(client);
  assert.strictEqual(diag.status, 'Online');
  assert.strictEqual(diag.ping, 42);
  assert.strictEqual(diag.connectedOnce, true);
});