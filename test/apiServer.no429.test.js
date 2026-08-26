const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('assert');

const { createApiServer } = require('../handlers/apiServer');

// Regression test for the roles-endpoint 429 root cause: the per-IP limiter
// (300/min) used to gate every response-cache miss. The dashboard calls this
// endpoint server-to-server through ONE backend egress IP, so all end users
// shared a single bucket and normal multi-guild usage could exhaust it ->
// "first request -> 429, Retry works". Authenticated requests must NEVER be
// rejected with 429 now, no matter how many cache misses occur.

const BOT_API_TOKEN = 'test-bot-api-token-not-a-real-secret-12345';

// Guild ID range unused by every other suite (negative-cache keys are shared
// per process; node --test isolates processes per file, but stay safe anyway).
function guildIdFor(i) {
    // 17-20 digit snowflake, unique per iteration.
    return String(810000000000000000n + BigInt(i));
}

function makeClient() {
    const fetchCounts = { guilds: 0 };
    return {
        _fetchCounts: fetchCounts,
        guilds: {
            cache: new Map(),
            fetch: async (id) => {
                fetchCounts.guilds += 1;
                return null; // bot is not in any of these guilds
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
    server = app.listen(0);
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

test('more than 300 authenticated cache-miss requests -> zero 429s', async () => {
    // Old behavior: request #301 within 60s from the same IP got RATE_LIMITED.
    // New behavior: bearer auth is the gate - every request gets a real answer.
    let rateLimited = 0;
    const statuses = [];
    for (let i = 0; i < 320; i++) {
        const res = await requestRoles(BOT_API_TOKEN, guildIdFor(i));
        statuses.push(res.status);
        if (res.status === 429) rateLimited += 1;
        else await res.json(); // drain body
    }
    assert.strictEqual(rateLimited, 0, 'authenticated requests must never be 429d');
    assert.ok(statuses.every((s) => s === 404), 'every miss resolves to a real answer (404 here)');
});

test('wrong token is still rejected even under heavy load', async () => {
    for (let i = 0; i < 5; i++) {
        const res = await requestRoles('wrong-token', guildIdFor(9000 + i));
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(await res.json(), { error: 'UNAUTHORIZED' });
    }
});
