const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('assert');

const { createApiServer } = require('../handlers/apiServer');

// Server-to-server shared secret between the dashboard BACKEND and the bot.
const BOT_API_TOKEN = 'test-bot-api-token-not-a-real-secret-12345';

const GUILD = '999999999999999991';
const ROLE_ID = '999999999999999992';
const UNKNOWN_GUILD = '777777777777777777';

function makeRole(id, name, overrides = {}) {
  return { id, name, color: 0, position: 1, mentionable: true, managed: false, ...overrides };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Client whose Discord-facing fetches are counted AND slow, so the tests can
// prove concurrent cache-miss requests collapse into a SINGLE Discord read
// (single flight) instead of duplicating bot-side Discord work.
function makeClient() {
  const fetchCounts = { guilds: 0, roles: 0 };
  const guild = {
    id: GUILD,
    memberCount: 50,
    roles: {
      // Empty at start => the endpoint performs exactly one roles.fetch().
      cache: new Map(),
      fetch: async () => {
        fetchCounts.roles += 1;
        await delay(40);
        guild.roles.cache.set(GUILD, makeRole(GUILD, '@everyone', { position: 0, mentionable: false }));
        guild.roles.cache.set(ROLE_ID, makeRole(ROLE_ID, 'Raid Ping', { position: 5 }));
      }
    }
  };
  const guildsMap = new Map([[GUILD, guild]]);
  return {
    _fetchCounts: fetchCounts,
    guilds: {
      cache: guildsMap,
      fetch: async (id) => {
        fetchCounts.guilds += 1;
        return guildsMap.get(id) || null;
      }
    },
    users: { cache: new Map() },
    ws: { ping: 1 },
    isReady: () => true,
    destroy: async () => {},
    login: async () => {}
  };
}

let client;
let server;
let baseUrl;

before(async () => {
  process.env.BOT_API_TOKEN = BOT_API_TOKEN;
  client = makeClient();
  const app = createApiServer(client);
  server = app.listen(0); // ephemeral port
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function requestRoles(token, guildId) {
  const headers = { Authorization: `Bearer ${token}` };
  return fetch(`${baseUrl}/api/guilds/${encodeURIComponent(guildId)}/roles`, { headers });
}

// ---------------------------------------------------------------------------
// 1. Two CONCURRENT first requests -> both 200, exactly ONE Discord roles read
// ---------------------------------------------------------------------------
test('two concurrent first requests -> both 200, exactly one Discord roles read', async () => {
  const responses = await Promise.all([
    requestRoles(BOT_API_TOKEN, GUILD),
    requestRoles(BOT_API_TOKEN, GUILD)
  ]);
  assert.strictEqual(responses[0].status, 200);
  assert.strictEqual(responses[1].status, 200);

  const b0 = await responses[0].json();
  const b1 = await responses[1].json();
  assert.deepStrictEqual(b0, b1);
  assert.ok(b0.roles.some((r) => r.id === ROLE_ID));
  // Single flight: the second concurrent miss shares the leader's promise.
  assert.strictEqual(client._fetchCounts.roles, 1, 'exactly one roles.fetch() for concurrent misses');
  assert.strictEqual(client._fetchCounts.guilds, 0, 'guild served from client.guilds.cache');
});

// ---------------------------------------------------------------------------
// 2. Rapid reloads after the single flight are cache hits (no Discord, no 429)
// ---------------------------------------------------------------------------
test('repeated reloads are cache hits: all 200, never 429, no Discord reads', async () => {
  for (let i = 0; i < 30; i++) {
    const res = await requestRoles(BOT_API_TOKEN, GUILD);
    assert.strictEqual(res.status, 200, `reload #${i + 1} should be 200`);
  }
  assert.strictEqual(client._fetchCounts.roles, 1, 'no extra Discord reads on cache hits');
  assert.strictEqual(client._fetchCounts.guilds, 0);
});

// ---------------------------------------------------------------------------
// 3. Unknown guild 404s once, then is negative-cached (no repeated Discord)
// ---------------------------------------------------------------------------
test('unknown guild -> 404, repeated requests never re-hit Discord (negative cache)', async () => {
  const first = await requestRoles(BOT_API_TOKEN, UNKNOWN_GUILD);
  assert.strictEqual(first.status, 404);
  assert.strictEqual(client._fetchCounts.guilds, 1, 'one targeted guilds.fetch() for unknown guild');

  for (let i = 0; i < 5; i++) {
    const res = await requestRoles(BOT_API_TOKEN, UNKNOWN_GUILD);
    assert.strictEqual(res.status, 404, `repeat #${i + 1} should stay 404`);
  }
  assert.strictEqual(client._fetchCounts.guilds, 1, 'negative cache absorbed the repeats');
});

// ---------------------------------------------------------------------------
// 4. Invalid token still rejected even with warm caches
// ---------------------------------------------------------------------------
test('invalid BOT_API_TOKEN still rejected (401)', async () => {
  const res = await requestRoles('wrong-secret-token', GUILD);
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(await res.json(), { error: 'UNAUTHORIZED' });
});
