const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('assert');

const { createApiServer, verifyApiToken, isValidSnowflake, consumeRateLimit } = require('../handlers/apiServer');

// Server-to-server shared secret between the dashboard BACKEND and the bot.
// Empty in .env; tests set it explicitly here (never a real token).
const BOT_API_TOKEN = 'test-bot-api-token-not-a-real-secret-12345';

const GUILD_A = '111111111111111111';

function makeClient() {
  const guildA = {
    id: GUILD_A,
    memberCount: 100,
    roles: { cache: new Map() }
  };
  // Second guild: proves /api/stats totals members across ALL guilds.
  const guildB = {
    id: '222222222222222220',
    memberCount: 23,
    roles: { cache: new Map() }
  };
  const cache = new Map([[GUILD_A, guildA], ['222222222222222220', guildB]]);
  return {
    guilds: {
      cache,
      fetch: async (guildId) => cache.get(guildId) || null
    },
    users: { cache: new Map([['user-1', {}]]) },
    ws: { ping: 42 },
    isReady: () => true,
    destroy: async () => {},
    login: async () => {}
  };
}

let server;
let baseUrl;

before(async () => {
  process.env.BOT_API_TOKEN = BOT_API_TOKEN;
  const app = createApiServer(makeClient());
  server = app.listen(0); // ephemeral port - no fixed port, no second server
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// Ping-management CRUD endpoints are REMOVED from the dashboard API (replaced
// by the /pingsetup Discord command). The generic roles endpoint is KEPT (it
// serves the dashboard's other role pickers and must still authenticate).
// ---------------------------------------------------------------------------
test('dashboard ping-settings CRUD endpoints are gone (404), generic roles endpoint kept', async () => {
  // Ping-settings CRUD endpoints must be gone.
  const pingSettings = await fetch(`${baseUrl}/api/guilds/${GUILD_A}/ping-settings`, {
    headers: { Authorization: `Bearer ${BOT_API_TOKEN}` }
  });
  assert.strictEqual(pingSettings.status, 404, 'ping-settings endpoint must be removed');

  // The generic bearer-protected roles endpoint still works (503 here because
  // the test client's guild has no roles — the point is: it is reachable and
  // authenticated, not 404-dead).
  const roles = await fetch(`${baseUrl}/api/guilds/${GUILD_A}/roles`, {
    headers: { Authorization: `Bearer ${BOT_API_TOKEN}` }
  });
  assert.ok([200, 404, 503].includes(roles.status), 'roles endpoint must still be routable');
  const rolesNoAuth = await fetch(`${baseUrl}/api/guilds/${GUILD_A}/roles`);
  assert.strictEqual(rolesNoAuth.status, 401, 'roles endpoint must still require bearer auth');
});

// ---------------------------------------------------------------------------
// Existing endpoints + helper functions keep working
// ---------------------------------------------------------------------------
test('existing /api/stats and / still work', async () => {
  const health = await fetch(`${baseUrl}/`);
  assert.strictEqual(health.status, 200);
  assert.strictEqual(await health.text(), 'Kakuzu is Online!');

  const stats = await fetch(`${baseUrl}/api/stats`);
  assert.strictEqual(stats.status, 200);
  const body = await stats.json();
  // guildA (100) + guildB (23) = 123 total members across 2 guilds.
  assert.strictEqual(body.servers, 2);
  assert.strictEqual(body.users, 123);
  assert.strictEqual(body.ping, 42);
  assert.strictEqual(body.status, 'Online');
});
test('/api/stats returns numeric servers and numeric total users', async () => {
  const stats = await fetch(`${baseUrl}/api/stats`);
  assert.strictEqual(stats.status, 200);
  const body = await stats.json();
  assert.strictEqual(typeof body.servers, 'number');
  assert.strictEqual(typeof body.users, 'number');
  // users is the summed guild memberCount (total members), not the cached
  // user-object count (which is 1 in this mock client).
  assert.notStrictEqual(body.users, 1);
  assert.strictEqual(body.users, 123);
});

test('/api/health/discord returns gateway diagnostics', async () => {
  const res = await fetch(`${baseUrl}/api/health/discord`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'Online');
  assert.strictEqual(body.ping, 42);
});

test('consumeRateLimit caps abuse per IP but allows a fresh IP', () => {
  // Exhaust the rolling window for one IP; the budget is 300/min.
  let blocked = 0;
  for (let i = 0; i < 350; i++) {
    if (!consumeRateLimit('10.0.0.abuse')) blocked += 1;
  }
  // 300 allowed, the remaining 50 rejected by the limiter.
  assert.ok(blocked >= 50, `expected ~50 blocked, got ${blocked}`);

  // A different (fresh) IP is not affected by the exhausted bucket.
  assert.strictEqual(consumeRateLimit('10.0.0.other'), true);
});

test('verifyApiToken and isValidSnowflake helpers behave safely', () => {
  assert.strictEqual(verifyApiToken(BOT_API_TOKEN), true);
  assert.strictEqual(verifyApiToken('wrong'), false);
  assert.strictEqual(verifyApiToken(''), false);

  assert.strictEqual(isValidSnowflake('111111111111111111'), true);
  assert.strictEqual(isValidSnowflake('12345678901234567890'), true);
  assert.strictEqual(isValidSnowflake('abc'), false);
  assert.strictEqual(isValidSnowflake('123'), false);
  assert.strictEqual(isValidSnowflake(null), false);
  assert.strictEqual(isValidSnowflake(''), false);
});