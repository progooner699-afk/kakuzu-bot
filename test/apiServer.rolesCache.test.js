const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('assert');

const { createApiServer } = require('../handlers/apiServer');

// Server-to-server shared secret between the dashboard BACKEND and the bot.
const BOT_API_TOKEN = 'test-bot-api-token-not-a-real-secret-12345';

// Distinct guild ID so this suite never collides with the cache entries from
// apiServer.test.js (the response cache is module-level for the process).
const GUILD_CACHE = '666666666666666661';
const UNKNOWN_GUILD = '777777777777777770';

function makeRole(id, name, overrides = {}) {
  return { id, name, color: 0, position: 1, mentionable: true, managed: false, ...overrides };
}

// Client whose Discord-facing fetches are counted AND fail loudly, so we can
// prove the endpoint never touches the Discord REST API on cache hits.
function makeCacheClient() {
  const fetchCounts = { guilds: 0, roles: 0 };
  const guild = {
    id: GUILD_CACHE,
    roles: {
      cache: new Map([
        // @everyone shares the guild ID - must never be returned.
        [GUILD_CACHE, makeRole(GUILD_CACHE, '@everyone', { position: 0, mentionable: false })],
        ['888888888888888881', makeRole('888888888888888881', 'NA Raid Ping', { position: 5 })],
        ['888888888888888882', makeRole('888888888888888882', 'EU Raid Ping', { position: 3 })]
      ]),
      fetch: async () => {
        fetchCounts.roles += 1;
        throw new Error('guild.roles.fetch should never be called during cache tests');
      }
    }
  };
  const guildsMap = new Map([[GUILD_CACHE, guild]]);
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
  client = makeCacheClient();
  const app = createApiServer(client);
  server = app.listen(0); // ephemeral port
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
// 1. First valid request -> 200, served from guild.roles.cache (no Discord)
// ---------------------------------------------------------------------------
test('first request -> 200 from guild.roles.cache, no Discord fetch', async () => {
  const res = await requestRoles(BOT_API_TOKEN, GUILD_CACHE);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.guild_id, GUILD_CACHE);
  // @everyone excluded -> exactly 2 selectable roles, highest position first.
  assert.strictEqual(body.roles.length, 2);
  assert.strictEqual(body.roles[0].id, '888888888888888881');
  assert.strictEqual(body.roles[1].id, '888888888888888882');
  // The guild + its roles were already cached: nothing was fetched from Discord.
  assert.strictEqual(client._fetchCounts.guilds, 0);
  assert.strictEqual(client._fetchCounts.roles, 0);
});
// ---------------------------------------------------------------------------
// 2. Immediate second request -> 200 from the response cache (frozen snapshot)
// ---------------------------------------------------------------------------
test('immediate second request -> 200 from cache, roles NOT re-read', async () => {
  // Poison the guild's role cache AFTER the first request: a fresh read would
  // now contain a 4th role, but the cached response must stay unchanged.
  const guild = client.guilds.cache.get(GUILD_CACHE);
  guild.roles.cache.set('888888888888888883', makeRole('888888888888888883', 'Late Role', { position: 9 }));

  const res = await requestRoles(BOT_API_TOKEN, GUILD_CACHE);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.roles.length, 2, 'cached snapshot must not include the role added later');
  assert.ok(!body.roles.some((r) => r.id === '888888888888888883'));

  // Still zero Discord REST calls - cache hit short-circuits everything.
  assert.strictEqual(client._fetchCounts.guilds, 0);
  assert.strictEqual(client._fetchCounts.roles, 0);
});
// ---------------------------------------------------------------------------
// 3. Rapid repeated refreshes -> all 200, no Discord 429, still cached
// ---------------------------------------------------------------------------
test('rapid repeated refreshes never 429 and never hit Discord', async () => {
  const beforeCount = client._fetchCounts.roles + client._fetchCounts.guilds;
  for (let i = 0; i < 30; i++) {
    const res = await requestRoles(BOT_API_TOKEN, GUILD_CACHE);
    assert.strictEqual(res.status, 200, `refresh #${i + 1} should be 200`);
  }
  // The first request of the whole suite already put this guild in the response
  // cache; none of these refreshes should have escaped to Discord either.
  const afterCount = client._fetchCounts.roles + client._fetchCounts.guilds;
  assert.strictEqual(afterCount, beforeCount, 'no new Discord fetches during refreshes');
});

// ---------------------------------------------------------------------------
// 4. Auth + unknown-guild protections still hold alongside caching
// ---------------------------------------------------------------------------
test('invalid BOT_API_TOKEN is still rejected (401)', async () => {
  const res = await requestRoles('wrong-secret-token', GUILD_CACHE);
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(await res.json(), { error: 'UNAUTHORIZED' });
});

test('unknown guild still returns 404', async () => {
  const res = await requestRoles(BOT_API_TOKEN, UNKNOWN_GUILD);
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'GUILD_NOT_FOUND' });
});