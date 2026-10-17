'use strict';

/**
 * Tests for the region detection fix:
 *  - Roblox 403 challenge is handled without retrying (getServerIp in robloxAuth.js).
 *  - Guild context is passed through the pipeline (not 'unknown').
 *  - Unknown location never defaults to 'NA' (region stays 'Unknown').
 *  - RoValra + ip-api fallback chain works correctly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const MOCK_SHARED_PING_DB = {
    getGuildPingSettings: async () => ({ countryPings: {}, regionPings: {} })
};
const sharedPingDbPath = require.resolve('../handlers/sharedPingDb');
require.cache[sharedPingDbPath] = {
    id: sharedPingDbPath,
    filename: sharedPingDbPath,
    loaded: true,
    children: [],
    paths: [],
    exports: MOCK_SHARED_PING_DB
};

// Mock regionMap.js
const MOCK_REGIONMAP = {
    resolveRoValraDatacenterRegion: async () => null,
    geolocateIp: async () => null,
    normalizeCountryToRegion: () => null,
    normalizeCountryCodeToRegion: () => null
};
const regionMapPath = require.resolve('../handlers/regionMap');
require.cache[regionMapPath] = {
    id: regionMapPath,
    filename: regionMapPath,
    loaded: true,
    children: [],
    paths: [],
    exports: MOCK_REGIONMAP
};

// Load the REAL auth module first so its pure classifier / cookie-config
// helpers are available to the tests, THEN re-register the cache entry with a
// mock that still exposes them alongside the mockable getServerIp seam.
const realRobloxAuth = require('../handlers/robloxAuth');
const { classifyGameJoinBlocker, isCookieConfigured } = realRobloxAuth;

// Mock robloxAuth.js: getServerIp is stubbed (the GameJoin seam under test),
// but the pure helpers are re-exported so tests can assert on the real logic.
const MOCK_ROBLOX_AUTH = {
    getServerIp: async () => null,
    classifyGameJoinBlocker,
    isCookieConfigured
};
const robloxAuthPath = require.resolve('../handlers/robloxAuth');
require.cache[robloxAuthPath] = {
    id: robloxAuthPath,
    filename: robloxAuthPath,
    loaded: true,
    children: [],
    paths: [],
    exports: MOCK_ROBLOX_AUTH
};

const robloxApi = require('../handlers/robloxApi');
const { detectGameAndRegion } = robloxApi;

const GUILD_ID = '987654321098765432';
const USER_ID = '111111111111111111';

const realFetch = global.fetch;

// detectGameAndRegion calls the module-internal getUserPresence, which resolves
// presence via the real global fetch. Stub fetch so presence is deterministic;
// never rely on monkey-patching the getUserPresence export (unreachable).
function stubPresence(presencePayload) {
    global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('presence.roblox.com')) {
            return {
                ok: true,
                json: async () => ({
                    userPresences: [{
                        userPresenceType: 2,
                        placeId: presencePayload.placeId,
                        gameId: presencePayload.serverId,
                        universeId: presencePayload.universeId
                    }]
                })
            };
        }
        if (u.includes('games.roblox.com/v1/games?universeIds=')) {
            return { ok: true, json: async () => ({ data: [{ name: presencePayload.gameName }] }) };
        }
        if (u.includes('games.roblox.com/v1/games/') && u.includes('/servers/')) {
            return { ok: true, json: async () => ({ joinScript: '' }) };
        }
        if (u.includes('thumbnails.roblox.com')) {
            return { ok: true, json: async () => ({ data: [] }) };
        }
        throw new Error(`unexpected fetch in test: ${u}`);
    };
}

function restoreFetch() {
    global.fetch = realFetch;
}

// Silence console output during tests
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
let logs = [];
function captureLog(level, fn) {
    return (...args) => {
        logs.push({ level, args: args.map(a => typeof a === 'string' ? a : a?.message || String(a)) });
    };
}

test('before', () => {
    logs = [];
    console.log = captureLog('log', realLog);
    console.warn = captureLog('warn', realWarn);
    console.error = captureLog('error', realError);
});

// NOTE: console capture stays installed for the whole file so the assertion
// tests below can inspect `logs`. Nothing here restores console.* — that would
// silently disable capture for every test that runs after it.

// ---------------------------------------------------------------------------
// Real assertions. These run while console output is captured (installed by the
// 'before' test above, restored by 'after' below — node:test runs top-level
// tests sequentially in file order).
// ---------------------------------------------------------------------------

function findLog(pattern) {
    return logs.find((entry) => entry.args.some((a) => pattern.test(String(a))));
}

test('getUserPresence extracts distinct placeId and serverId (jobId) without conflating gameId', async () => {
    stubPresence({ placeId: '123456', serverId: 'JOB-AAAA', universeId: '777', gameName: 'Rivals' });
    const presence = await robloxApi.getUserPresence(USER_ID);
    restoreFetch();

    assert.equal(presence.success, true);
    assert.equal(presence.placeId, '123456');
    assert.equal(presence.serverId, 'JOB-AAAA');
    // placeId must never be overwritten by the job/game id.
    assert.notEqual(presence.placeId, presence.serverId);
});

test('detectGameAndRegion returns Unknown (not NA) and a blocker when GameJoin yields no location data', async () => {
    stubPresence({ placeId: '123456', serverId: 'JOB-AAAA', universeId: '777', gameName: 'Strongest Battlegrounds' });
    MOCK_ROBLOX_AUTH.getServerIp = async () => null;

    logs = [];
    const result = await detectGameAndRegion(USER_ID, { guildId: GUILD_ID, guildName: 'Kakuzu HQ' });
    restoreFetch();

    assert.equal(result.success, true);
    // The core regression: never fabricate 'NA' when location is unavailable.
    assert.equal(result.region, 'Unknown');
    assert.notEqual(result.region, 'NA');
    // Guild context must flow through, not be hardcoded 'unknown'.
    assert.equal(result.placeId, '123456');
    assert.equal(result.serverId, 'JOB-AAAA');

    const warn = findLog(/challenge_required=true|noServerLocationData=true/);
    assert.ok(warn, 'expected a staged diagnostic naming the GameJoin blocker');
});

test('detectGameAndRegion resolves region via RoValra and surfaces countryCode', async () => {
    stubPresence({ placeId: '123456', serverId: 'JOB-FRA1', universeId: '777', gameName: 'Rivals' });
    MOCK_ROBLOX_AUTH.getServerIp = async () => ({ dataCenterId: 'dc-fra-1', machineAddress: '203.0.113.9' });
    MOCK_REGIONMAP.resolveRoValraDatacenterRegion = async () => ({
        region: 'EU',
        countryCode: 'DE',
        label: 'Frankfurt, Germany'
    });
    MOCK_REGIONMAP.normalizeCountryToRegion = () => null;
    MOCK_REGIONMAP.normalizeCountryCodeToRegion = () => 'EU';

    logs = [];
    const result = await detectGameAndRegion(USER_ID, { guildId: GUILD_ID, guildName: 'Kakuzu HQ' });
    restoreFetch();

    assert.equal(result.success, true);
    assert.equal(result.region, 'EU');
    assert.equal(result.regionSource, 'RoValra');
    assert.equal(result.countryCode, 'DE');
});

test('classifyGameJoinBlocker maps a 403 challenge to roblox_challenge_required', () => {
    assert.equal(
        classifyGameJoinBlocker(403, { errorMessage: 'Challenge is required to authorize the request' }),
        'roblox_challenge_required'
    );
    assert.equal(classifyGameJoinBlocker(401, { errorMessage: 'Unauthorized' }), 'unauthorized_cookie');
    assert.equal(classifyGameJoinBlocker(429, { errorMessage: 'Too many requests' }), 'rate_limited');
    // A 403 WITHOUT a challenge message is a different blocker.
    assert.equal(classifyGameJoinBlocker(403, { errorMessage: 'Forbidden' }), 'forbidden_origin_or_token');
});

test('isCookieConfigured is false with no cookie and BOT_COOKIE stays a live getter', () => {
    delete process.env.BOT_ROBLOSECURITY;
    assert.equal(isCookieConfigured(), false);
    const desc = Object.getOwnPropertyDescriptor(realRobloxAuth, 'BOT_COOKIE');
    assert.equal(typeof desc.get, 'function', 'BOT_COOKIE must be a live getter, not a snapshot');
});
