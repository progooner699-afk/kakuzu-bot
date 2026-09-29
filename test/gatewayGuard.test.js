const test = require('node:test');
const assert = require('assert');

const {
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

// ── Self-heal watchdog: decision logic (the "online but deaf for days" fix) ──
// Every test drives `runWatchdogTick`/`evaluateGateway` with an explicit `now`
// so nothing depends on wall-clock sleeps.

/** A client that was READY at t0 and then lost its gateway socket. */
function makeDroppedClient() {
  const client = makeClient();
  attachGatewayGuard(client);
  client.emit('shardReady', 0);   // connectedOnce = true, lastReadySeenAt = t0
  const t0 = Date.now();
  client._setReady(false);
  return { client, t0 };
}

test('WATCHDOG_DEFAULTS are sane (guards the 30*000 typo and runaway polling)', () => {
  assert.ok(WATCHDOG_DEFAULTS.intervalMs >= 5000, 'tick cadence must not hammer Discord');
  assert.ok(WATCHDOG_DEFAULTS.notReadyGraceMs >= 30000, 'a brief reconnect must never trigger a forced relogin');
  assert.ok(WATCHDOG_DEFAULTS.minReconnectSpacingMs >= 30000, 'identify rate limits need spacing');
  assert.ok(WATCHDOG_DEFAULTS.maxReconnects >= 1 && WATCHDOG_DEFAULTS.maxReconnects <= 10);
  assert.strictEqual(WATCHDOG_DEFAULTS.zombiePingMs, 30000, 'zombie ping threshold must be 30s, not 30*000 -> 0');
  assert.ok(Object.isFrozen(WATCHDOG_DEFAULTS));
});

test('evaluateGateway holds inside the grace window and asks to reconnect after it', () => {
  const { client, t0 } = makeDroppedClient();
  const opts = { notReadyGraceMs: 45000, minReconnectSpacingMs: 60000 };
  const held = evaluateGateway(client, opts, t0 + 10000);
  assert.strictEqual(held.action, 'none', 'inside the grace window nothing may happen');
  assert.match(held.reasons.join(' '), /not-ready-grace/);
  const act = evaluateGateway(client, opts, t0 + 60000);
  assert.strictEqual(act.action, 'reconnect');
  assert.match(act.reasons.join(' '), /gateway-down/);
});

test('evaluateGateway never acts once markShuttingDown has run (SIGTERM race)', () => {
  const { client, t0 } = makeDroppedClient();
  markShuttingDown(client);
  const verdict = evaluateGateway(client, { notReadyGraceMs: 0, minReconnectSpacingMs: 0 }, t0 + 60 * 60 * 1000);
  assert.strictEqual(verdict.action, 'none', 'the removed watchdog relogged during shutdown; this one must not');
  assert.deepStrictEqual(verdict.reasons, ['shutting-down']);
});

test('runWatchdogTick is a complete no-op during shutdown (no destroy, no login)', async () => {
  const { client, t0 } = makeDroppedClient();
  markShuttingDown(client);
  const verdict = await runWatchdogTick(client, { notReadyGraceMs: 0, minReconnectSpacingMs: 0 }, t0 + 60 * 60 * 1000);
  assert.strictEqual(verdict.action, 'none');
  assert.strictEqual(client.destroyedCalls, 0);
  assert.strictEqual(client.loginCalls, 0);
});

test('runWatchdogTick self-heals a gateway that is down past the grace window', async () => {
  const { client, t0 } = makeDroppedClient();
  const savedToken = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = 'test-token';
  try {
    const verdict = await runWatchdogTick(client, { notReadyGraceMs: 45000, minReconnectSpacingMs: 60000 }, t0 + 120000);
    assert.strictEqual(verdict.action, 'reconnect');
    assert.strictEqual(client.destroyedCalls, 1, 'the dead socket must be destroyed first');
    assert.strictEqual(client.loginCalls, 1, 'a fresh gateway session must be established');
    const diag = getGatewayDiagnostics(client);
    assert.strictEqual(diag.watchdog.reconnects, 1);
    assert.strictEqual(diag.watchdog.lastAction, 'reconnect');
  } finally {
    if (savedToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = savedToken;
  }
});

test('runWatchdogTick respects the reconnect spacing gate (never fights identify limits)', async () => {
  const { client, t0 } = makeDroppedClient();
  const opts = { notReadyGraceMs: 1000, minReconnectSpacingMs: 60000 };
  const first = await runWatchdogTick(client, opts, t0 + 5000);
  assert.strictEqual(first.action, 'reconnect');
  const second = await runWatchdogTick(client, opts, t0 + 10000);
  assert.strictEqual(second.action, 'wait');
  assert.match(second.reasons.join(' '), /spacing/);
  assert.strictEqual(client.destroyedCalls, 1, 'a second reconnect inside the spacing window must not happen');
});

test('runWatchdogTick gives up (fatal) instead of reconnecting forever', async () => {
  const { client, t0 } = makeDroppedClient();
  const fatalCalls = [];
  const opts = {
    notReadyGraceMs: 1000, minReconnectSpacingMs: 0, maxReconnects: 1,
    fatal: async (verdict) => { fatalCalls.push(verdict); },
  };
  const first = await runWatchdogTick(client, opts, t0 + 5000);
  assert.strictEqual(first.action, 'reconnect');
  const second = await runWatchdogTick(client, opts, t0 + 10000);
  assert.strictEqual(second.action, 'fatal');
  assert.match(second.reasons.join(' '), /budget-exhausted/);
  assert.strictEqual(fatalCalls.length, 1, 'the host must be told to recycle the process exactly once');
  assert.strictEqual(getGatewayDiagnostics(client).watchdog.gaveUp, true);
});

test('runWatchdogTick holds when the gateway AND the REST API are both down', async () => {
  const { client, t0 } = makeDroppedClient();
  client.rest = { get: async () => { throw new Error('ECONNREFUSED'); } };
  const verdict = await runWatchdogTick(client,
    { notReadyGraceMs: 1000, minReconnectSpacingMs: 0, restProbeTimeoutMs: 100 }, t0 + 5000);
  assert.strictEqual(verdict.action, 'reconnect', 'the verdict may still ask for a reconnect...');
  assert.strictEqual(client.destroyedCalls, 0, '...but nothing must be attempted while REST is dead');
  assert.strictEqual(client.loginCalls, 0);
  assert.strictEqual(getGatewayDiagnostics(client).watchdog.reconnects, 0,
    'a blocked probe must not burn the identify budget');
});

test('runWatchdogTick reconnects a ready-but-stale socket after consecutive high-ping ticks', async () => {
  const client = makeClient();
  attachGatewayGuard(client);
  client.emit('shardReady', 0);
  client.ws.ping = 40000;   // above zombiePingMs while still "ready"
  const t0 = Date.now();
  const opts = { zombiePingMs: 30000, zombieTicks: 3, minReconnectSpacingMs: 0 };
  for (let i = 1; i <= 2; i += 1) {
    const probe = await runWatchdogTick(client, opts, t0 + i * 1000);
    assert.strictEqual(probe.action, 'none', 'tick ' + i + ' is still inside the high-ping tolerance');
    assert.match(probe.reasons.join(' '), /high-ping/);
  }
  const verdict = await runWatchdogTick(client, opts, t0 + 3000);
  assert.strictEqual(verdict.action, 'reconnect', 'a rotting socket must be recycled');
  assert.match(verdict.reasons.join(' '), /gateway-stale/);
  assert.strictEqual(client.destroyedCalls, 1);
});

test('probeRestGateway is truthful about missing, healthy, dead and hung REST clients', async () => {
  assert.strictEqual(await probeRestGateway({ rest: null }, 50), true, 'no REST client -> assume the gateway is the problem');
  assert.strictEqual(await probeRestGateway({ rest: { get: async () => ({ id: 'bot' }) } }, 50), true);
  assert.strictEqual(await probeRestGateway({ rest: { get: async () => { throw new Error('401'); } } }, 50), false);
  assert.strictEqual(await probeRestGateway({ rest: { get: () => new Promise(() => {}) } }, 50), false,
    'a hung REST probe must time out instead of holding the tick');
});

test('markActivity never fakes gateway liveness while the socket is down', () => {
  const { client, t0 } = makeDroppedClient();
  markActivity(client);   // fresh traffic for the silence counter only
  const verdict = evaluateGateway(client, { notReadyGraceMs: 1000 }, t0 + 600000);
  assert.strictEqual(verdict.action, 'reconnect',
    'traffic alone must not mask a dead gateway (' + verdict.reasons.join(' ') + ')');
  assert.ok(verdict.downSince > 590000, 'the gateway-down clock keeps running (got ' + verdict.downSince + 'ms)');
});

test('watchdog arms once, unrefs its timer and is disarmed by markShuttingDown', () => {
  const client = makeClient();
  attachGatewayGuard(client);
  assert.strictEqual(startGatewayWatchdog(client, { intervalMs: 60000 }), true);
  assert.strictEqual(startGatewayWatchdog(client, { intervalMs: 60000 }), false, 'arming twice would double the ticks');
  assert.strictEqual(getGatewayDiagnostics(client).watchdog.armed, true);
  markShuttingDown(client);
  assert.strictEqual(getGatewayDiagnostics(client).watchdog.armed, false,
    'shutdown MUST disarm the watchdog before the client is destroyed (the 0b626e9 race)');
  stopGatewayWatchdog(client);
  assert.strictEqual(getGatewayDiagnostics(client).watchdog.armed, false);
});

test('getGatewayDiagnostics exposes watchdog telemetry and liveness counters', () => {
  const client = makeClient();
  attachGatewayGuard(client);
  const diag = getGatewayDiagnostics(client);
  assert.strictEqual(typeof diag.silentForMs, 'number');
  assert.strictEqual(typeof diag.gatewayDownForMs, 'number');
  assert.deepStrictEqual(Object.keys(diag.watchdog).sort(),
    ['armed', 'gaveUp', 'highPingTicks', 'lastAction', 'lastReasons', 'reconnects', 'running']);
  assert.strictEqual(diag.watchdog.armed, false);
  assert.strictEqual(diag.watchdog.reconnects, 0);
  assert.strictEqual(diag.watchdog.gaveUp, false);
  assert.deepStrictEqual(diag.watchdog.lastReasons, []);
});
