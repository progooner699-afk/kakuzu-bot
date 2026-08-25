const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('assert');

const { createApiServer, verifyApiToken, isValidSnowflake } = require('../handlers/apiServer');

// Server-to-server shared secret between the dashboard BACKEND and the bot.
// Empty in .env; tests set it explicitly here (never a real token).
const BOT_API_TOKEN = 'test-bot-api-token-not-a-real-secret-12345';

const GUILD_A = '111111111111111111';

function makeRole(id, name, overrides = {}) {
  return { id, name, color: 0, position: 1, mentionable: true, managed: false, ...overrides };
}

function makeClient() {
  const guildA = {
    id: GUILD_A,
    roles: {
      cache: new Map([
        // @everyone shares the guild ID - must never be returned.
        [GUILD_A, makeRole(GUILD_A, '@everyone', { position: 0, mentionable: false })],
        [
'222222222222222222',
          makeRole('222222222222222222', 'SG Raid Ping', { position: 5, color: 0xFF0000 })
        ],
        ['333333333333333333', makeRole('333333333333333333', 'EU Raid Ping', { position: 3 })],
        // Managed/integration role: must be excluded from selectable results.
        ['444444444444444444', makeRole('444444444444444444', 'Bot Managed', { position: 9, managed: true })],
        ['555555555555555555', makeRole('555555555555555555', 'Lowest', { position: 0 })]
      ])
    }
  };
  const cache = new Map([[GUILD_A, guildA]]);
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

async function requestRoles(token, guildId) {
  const headers = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/api/guilds/${encodeURIComponent(guildId)}/roles`, { headers });
}

// ---------------------------------------------------------------------------
// 1. Valid token + guild the bot belongs to -> 200 + role list
// ---------------------------------------------------------------------------
test('valid token + guild bot belongs to -> 200 with selectable roles', async () => {
  const res = await requestRoles(BOT_API_TOKEN, GUILD_A);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.guild_id, GUILD_A);
  assert.ok(Array.isArray(body.roles));

  // @everyone and managed role excluded -> exactly 3 remain, highest position first.
  assert.strictEqual(body.roles.length, 3);
  assert.strictEqual(body.roles[0].id, '222222222222222222'); // position 5
  assert.strictEqual(body.roles[1].id, '333333333333333333'); // position 3
  assert.strictEqual(body.roles[2].id, '555555555555555555'); // position 0

  // Response shape matches the contract - only the minimal fields, as strings/numbers/booleans.
  for (const role of body.roles) {
    assert.deepStrictEqual(
      Object.keys(role).sort(),
      ['color', 'id', 'managed', 'mentionable', 'name', 'position'].sort()
    );
    assert.strictEqual(typeof role.id, 'string');
    assert.strictEqual(typeof role.name, 'string');
    assert.strictEqual(typeof role.color, 'number');
    assert.strictEqual(typeof role.position, 'number');
    assert.strictEqual(typeof role.mentionable, 'boolean');
    assert.strictEqual(typeof role.managed, 'boolean');
  }

  assert.ok(body.roles.find((r) => r.name === 'SG Raid Ping'));
  assert.ok(!body.roles.find((r) => r.managed));
});

// ---------------------------------------------------------------------------
// 2./3. Missing / wrong token -> rejected
// ---------------------------------------------------------------------------
test('missing token -> 401 UNAUTHORIZED', async () => {
  const res = await requestRoles(undefined, GUILD_A);
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(await res.json(), { error: 'UNAUTHORIZED' });
});

test('wrong token -> 401 UNAUTHORIZED', async () => {
  const res = await requestRoles('wrong-secret-token', GUILD_A);
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(await res.json(), { error: 'UNAUTHORIZED' });
});

// ---------------------------------------------------------------------------
// 4. Invalid guild ID -> 400
// ---------------------------------------------------------------------------
test('invalid guild ID -> 400 INVALID_GUILD_ID', async () => {
  for (const bad of ['abc', '123', '12.5', 'abc-def-ghij']) {
    const res = await requestRoles(BOT_API_TOKEN, bad);
    assert.strictEqual(res.status, 400, `expected 400 for guildId=${bad}`);
    assert.deepStrictEqual(await res.json(), { error: 'INVALID_GUILD_ID' });
  }
});

// ---------------------------------------------------------------------------
// 5. Valid guild id but bot is not in the guild -> 404 GUILD_NOT_FOUND
// ---------------------------------------------------------------------------
test('guild bot does not belong to -> 404 GUILD_NOT_FOUND', async () => {
  const res = await requestRoles(BOT_API_TOKEN, '999999999999999999');
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'GUILD_NOT_FOUND' });
});

test('guild not in cache (fetch fallback returns null) -> 404 GUILD_NOT_FOUND', async () => {
  const res = await requestRoles(BOT_API_TOKEN, '888888888888888888');
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'GUILD_NOT_FOUND' });
});

// ---------------------------------------------------------------------------
// 6. @everyone is never returned as a selectable role
// ---------------------------------------------------------------------------
test('@everyone is never returned as a selectable role', async () => {
  const res = await requestRoles(BOT_API_TOKEN, GUILD_A);
  const body = await res.json();
  assert.ok(!body.roles.some((r) => r.id === GUILD_A), '@everyone role id must not appear');
  assert.ok(!body.roles.some((r) => r.name === '@everyone'));
});

// ---------------------------------------------------------------------------
// 7. Secrets never appear in responses or logs
// ---------------------------------------------------------------------------
test('BOT_API_TOKEN never appears in any response body', async () => {
  const scenarios = [
    () => requestRoles(BOT_API_TOKEN, GUILD_A),
    () => requestRoles('wrong-secret-token', GUILD_A),
    () => requestRoles(undefined, GUILD_A),
    () => requestRoles(BOT_API_TOKEN, 'abc'),
    () => requestRoles(BOT_API_TOKEN, '999999999999999999')
  ];
  for (const make of scenarios) {
    const res = await make();
    const text = await res.clone().text();
    assert.ok(!text.includes(BOT_API_TOKEN), 'response body must not contain the token');
    assert.ok(!text.toLowerCase().includes('bearer'), 'response body must not echo the header');
  }
});

test('BOT_API_TOKEN never appears in server logs', async () => {
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    await requestRoles(BOT_API_TOKEN, GUILD_A);
    await requestRoles('nope', GUILD_A);
    await fetch(`${baseUrl}/api/action/restart`, { method: 'POST' });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  const all = logs.join('\n');
  assert.ok(!all.includes(BOT_API_TOKEN), 'logs must not contain BOT_API_TOKEN');
  assert.ok(!/Bearer\s+"?[A-Za-z0-9_-]+/.test(all), 'logs must not contain Authorization values');
});

// ---------------------------------------------------------------------------
// 8. Existing endpoints + helper functions keep working
// ---------------------------------------------------------------------------
test('existing /api/stats and / still work', async () => {
  const health = await fetch(`${baseUrl}/`);
  assert.strictEqual(health.status, 200);
  assert.strictEqual(await health.text(), 'Kakuzu is Online!');

  const stats = await fetch(`${baseUrl}/api/stats`);
  assert.strictEqual(stats.status, 200);
  const body = await stats.json();
  assert.strictEqual(body.servers, 1);
  assert.strictEqual(body.ping, 42);
  assert.strictEqual(body.status, 'Online');
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
