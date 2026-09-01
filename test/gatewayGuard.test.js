const test = require('node:test');
const assert = require('assert');

const {
  attachGatewayGuard,
  reconnectDiscord,
  markShuttingDown,
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
    emit: (event, ...args) => {
      (listeners.get(event) || []).forEach((fn) => fn(...args));
    },
    _setReady: (v) => { readyState = v; },
    _listeners: listeners,
  };
  return client;
}

test('attachGatewayGuard registers an error listener', () => {
  const client = makeClient();
  attachGatewayGuard(client);
  assert.strictEqual(client._listeners.has('error'), true);
  assert.doesNotThrow(() => client.emit('error', new Error('boom')));
});

test('reconnectDiscord is single-flight', async () => {
  const client = makeClient();
  attachGatewayGuard(client);
  const results = await Promise.all([reconnectDiscord(client, 'test-token'), reconnectDiscord(client, 'test-token')]);
  assert.strictEqual(client.destroyedCalls, 1);
  assert.strictEqual(client.loginCalls, 1);
  assert.deepStrictEqual(results, [true, false]);
});

test('reconnectDiscord returns false when shutting down', async () => {
  const client = makeClient();
  attachGatewayGuard(client);
  markShuttingDown(client);
  const ok = await reconnectDiscord(client, 'test-token');
  assert.strictEqual(ok, false);
  assert.strictEqual(client.destroyedCalls, 0);
  assert.strictEqual(client.loginCalls, 0);
});

test('getGatewayDiagnostics reports ready state, ping, shutdown', () => {
  const client = makeClient();
  attachGatewayGuard(client);
  const diag = getGatewayDiagnostics(client);
  assert.strictEqual(diag.status, 'Online');
  assert.strictEqual(diag.ping, 42);
  assert.strictEqual(diag.connectedOnce, false);
  assert.strictEqual(diag.shuttingDown, false);
});

test('getGatewayDiagnostics reports shutdown flag after markShuttingDown', () => {
  const client = makeClient();
  attachGatewayGuard(client);
  markShuttingDown(client);
  const diag = getGatewayDiagnostics(client);
  assert.strictEqual(diag.shuttingDown, true);
});
