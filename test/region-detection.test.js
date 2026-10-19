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

/**
 * Builds a mock fetch Response headers object that supports challenge headers.
 * Used by gamejoin tests to verify challenge-type detection.
 * Safe: the challenge-id and metadata values are test secrets that are never
 * expected to appear in persisted records.
 */
function makeMockHeaders(opts = {}) {
    const headers = {};
    if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
    if (opts.challengeType) headers['rblx-challenge-type'] = opts.challengeType;
    if (opts.challengeId) headers['rblx-challenge-id'] = opts.challengeId;
    if (opts.challengeMeta) headers['rblx-challenge-metadata'] = opts.challengeMeta;
    if (opts.contentType) headers['content-type'] = opts.contentType;
    return {
        get: (name) => headers[String(name).toLowerCase()] || null,
        getSetCookie: () => opts.setCookie || []
    };
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

// ---------------------------------------------------------------------------
// Regression tests for the Oct-2026 detection-chain repair.
// ---------------------------------------------------------------------------

test('missing serverId: GameJoin never runs, region stays Unknown (never NA), diagnostic names the missing jobId', async () => {
    stubPresence({ placeId: '123456', serverId: null, universeId: '777', gameName: 'Rivals' });
    let gameJoinCalled = false;
    MOCK_ROBLOX_AUTH.getServerIp = async () => { gameJoinCalled = true; return null; };

    logs = [];
    const result = await detectGameAndRegion(USER_ID, { guildId: GUILD_ID, guildName: 'Kakuzu HQ' });
    restoreFetch();

    assert.equal(result.success, true);
    assert.equal(gameJoinCalled, false, 'GameJoin must not be attempted without a server job id');
    assert.equal(result.serverId, null);
    // Core invariant: an unresolvable location is Unknown, never fabricated NA.
    assert.equal(result.region, 'Unknown');
    assert.notEqual(result.region, 'NA');
    assert.equal(result.regionSource, null);

    const warn = findLog(/missingServerId=true/);
    assert.ok(warn, 'expected a staged diagnostic naming the missing jobId');
});

test('previously successful flow reproduces the Oct-11 log: RoValra Mumbai -> ASIA / IN with guild context', async () => {
    stubPresence({ placeId: '10449761463', serverId: 'JOB-AAAA', universeId: '777', gameName: 'Rivals' });
    let gameJoinContext = null;
    MOCK_ROBLOX_AUTH.getServerIp = async (placeId, serverId, context) => {
        gameJoinContext = context || null;
        return { machineAddress: '203.0.113.10', publicAddress: '198.51.100.20', dataCenterId: '359' };
    };
    MOCK_REGIONMAP.resolveRoValraDatacenterRegion = async () => ({
        region: 'ASIA',
        countryCode: 'IN',
        label: 'Mumbai, India'
    });
    MOCK_REGIONMAP.normalizeCountryToRegion = () => null;
    MOCK_REGIONMAP.normalizeCountryCodeToRegion = () => 'ASIA';

    logs = [];
    const result = await detectGameAndRegion(USER_ID, { guildId: GUILD_ID, guildName: 'Kakuzu HQ', raidId: 42 });
    restoreFetch();

    assert.equal(result.success, true);
    assert.equal(result.region, 'ASIA');
    assert.equal(result.countryCode, 'IN');
    assert.equal(result.regionSource, 'RoValra');
    assert.equal(result.regionLabel, 'Mumbai, India');

    // Guild context must reach BOTH the GameJoin seam and the staged logs
    // (was dead-wired before the fix).
    assert.ok(gameJoinContext, 'getServerIp must receive the detection context');
    assert.equal(gameJoinContext.guildId, GUILD_ID);
    assert.equal(String(gameJoinContext.raidId), '42');
    assert.ok(
        findLog(/guild=987654321098765432 guildName="Kakuzu HQ"/),
        'staged diagnostics must carry the real guild id/name, not unknown'
    );
});

test('real getServerIp on a live-shape 403 challenge records a safe attempt and fires the challenge branch', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_never_persist';
    const CSRF_TOKEN = 'FAKE-CSRF-TOKEN-never_log';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;

    const makeHeaders = (opts = {}) => {
        const headers = {};
        if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
        if (opts.challengeType) headers['rblx-challenge-type'] = opts.challengeType;
        if (opts.challengeId) headers['rblx-challenge-id'] = opts.challengeId;
        if (opts.challengeMeta) headers['rblx-challenge-metadata'] = opts.challengeMeta;
        if (opts.contentType) headers['content-type'] = opts.contentType;
        return {
            get: (name) => headers[String(name).toLowerCase()] || null,
            getSetCookie: () => opts.setCookie || []
        };
    };

    logs = [];
    try {
        global.fetch = async (url) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeHeaders({}), json: async () => ({ id: 424242 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeHeaders({ csrf: CSRF_TOKEN }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                // Live-shape body: NO `status: 403` field, only errorCode/errorMessage.
                return {
                    ok: false,
                    status: 403,
                    statusMessage: 'Forbidden',
                    headers: makeHeaders({ csrf: CSRF_TOKEN }),
                    json: async () => ({ errorCode: 0, errorMessage: 'Challenge is required to authorize the request' })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-AAAA', { guildId: GUILD_ID, raidId: 42 });
        assert.equal(result, null, 'a challenge-blocked join must resolve to null (no fabricated location)');

        // The challenge branch must fire on the live body shape (was dead code).
        assert.ok(findLog(/challenge_required=true/), 'challenge branch must fire for a live 403 body');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec, 'noteAttempt must persist the attempt for /raiddebug');
        assert.equal(rec.httpStatus, 403);
        assert.equal(rec.joinScript, false);
        assert.equal(rec.csrfPresent, true);
        assert.equal(rec.blocker, 'roblox_challenge_required');
        // Challenge header diagnostics (this test has NO rblx-challenge-type header).
        assert.equal(rec.challengeType, null, 'challengeType must be null when no challenge header is present');
        assert.equal(rec.challengeHeadersPresent, false, 'challengeHeadersPresent must be false without the header');
        assert.equal(rec.challengeIdPresent, false, 'challengeIdPresent must be false without the header');
        assert.equal(rec.challengeMetaPresent, false, 'challengeMetaPresent must be false without the header');
        assert.equal(rec.bodyJsonValid, true, 'body must be valid JSON in this test');
        assert.equal(rec.responseContentType, null, 'responseContentType must be null when no content-type header is set');
        assert.equal(rec.guildId, GUILD_ID);
        assert.equal(String(rec.raidId), '42');
        assert.equal(rec.placeId, '10449761463');
        assert.equal(rec.serverId, 'JOB-AAAA');
        assert.match(String(rec.errorMessage), /challenge/i);

        // Secrets must never be persisted in the diagnostics record.
        const serialized = JSON.stringify(rec);
        assert.ok(!serialized.includes(COOKIE_SECRET), 'record must never contain the cookie value');
        assert.ok(!serialized.includes(CSRF_TOKEN), 'record must never contain the CSRF token');
        // Challenge-id (if present) must never be persisted either.
        assert.ok(!serialized.includes('challenge-id-value'), 'record must never contain a challenge id value');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        restoreFetch();
    }
});

test('classifyGameJoinBlocker: HTTP status drives the class when the body omits it (dead-code pin)', () => {
    // Live 403 body: no challenge message in the body, status only on HTTP.
    assert.equal(classifyGameJoinBlocker(403, {}), 'forbidden_origin_or_token');
    assert.equal(classifyGameJoinBlocker(200, { errorMessage: 'no problem' }), 'no_join_script');
    // classifyGameJoinBlocker keys the challenge off the message; the HTTP
    // status is what reaches it (response.httpStatus) after the fix.
    assert.equal(classifyGameJoinBlocker(403, { errorMessage: 'Challenge is required' }), 'roblox_challenge_required');
    // A 403 with rblx-challenge-type header is identified as challenge even
    // when the body message does not mention "challenge".
    assert.equal(classifyGameJoinBlocker(403, { challengeType: 'captcha' }), 'roblox_challenge_required');
    assert.equal(classifyGameJoinBlocker(403, { challengeType: 'turnstile' }), 'roblox_challenge_required');
    // A 200 with a challenge header is NOT an error — falls through to no_join_script.
    assert.equal(classifyGameJoinBlocker(200, { challengeType: 'captcha' }), 'no_join_script');
    // 403 without challengeType and no challenge message = forbidden, not challenge.
    assert.equal(classifyGameJoinBlocker(403, {}), 'forbidden_origin_or_token');
});

// ---------------------------------------------------------------------------
// TASK 1 + 2: 403 WITH challenge headers — verify the challenge type is
// positively identified from the rblx-challenge-type response header.
// ---------------------------------------------------------------------------

test('getServerIp: 403 with rblx-challenge-type header fires challenge branch and persists the type', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_challenge_header';
    const CSRF_TOKEN = 'FAKE-CSRF-TOKEN_challenge';
    const CHALLENGE_ID_SECRET = 'challenge-id-value-secret-never-logged';
    const CHALLENGE_META_SECRET = 'metadata-contents-secret-never-logged';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;

    logs = [];
    try {
        global.fetch = async (url) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 424242 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: CSRF_TOKEN }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                return {
                    ok: false,
                    status: 403,
                    statusMessage: 'Forbidden',
                    headers: makeMockHeaders({
                        csrf: CSRF_TOKEN,
                        challengeType: 'captcha',
                        challengeId: CHALLENGE_ID_SECRET,
                        challengeMeta: CHALLENGE_META_SECRET,
                        contentType: 'application/json'
                    }),
                    json: async () => ({ errorCode: 0, errorMessage: 'Challenge is required to authorize the request' })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-AAAA', { guildId: GUILD_ID, raidId: 42 });
        assert.equal(result, null, 'a challenge-blocked join must resolve to null (no fabricated location)');

        // Challenge branch must fire.
        assert.ok(findLog(/challenge_required=true/), 'challenge branch must fire');
        assert.ok(findLog(/challengeType=captcha/), 'challenge type must appear in logs');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec, 'noteAttempt must persist the attempt for /raiddebug');
        assert.equal(rec.httpStatus, 403);
        assert.equal(rec.challengeType, 'captcha', 'challengeType must be persisted from the rblx-challenge-type header');
        assert.equal(rec.challengeHeadersPresent, true, 'challengeHeadersPresent must be true when the header is present');
        assert.equal(rec.challengeIdPresent, true, 'challengeIdPresent must be true (the ID value itself is never logged)');
        assert.equal(rec.challengeMetaPresent, true, 'challengeMetaPresent must be true (metadata contents are never logged)');
        assert.equal(rec.bodyJsonValid, true, 'body must be valid JSON');
        assert.equal(rec.responseContentType, 'application/json');
        assert.equal(rec.blocker, 'roblox_challenge_required');
        assert.ok(!rec.joinScript, 'no joinScript on a challenge');

        // Secrets must never be persisted in the diagnostics record.
        const serialized = JSON.stringify(rec);
        assert.ok(!serialized.includes(COOKIE_SECRET), 'record must never contain the cookie value');
        assert.ok(!serialized.includes(CSRF_TOKEN), 'record must never contain the CSRF token');
        assert.ok(!serialized.includes(CHALLENGE_ID_SECRET), 'record must never contain the challenge-id value');
        assert.ok(!serialized.includes(CHALLENGE_META_SECRET), 'record must never contain the challenge-metadata contents');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        restoreFetch();
    }
});

// ---------------------------------------------------------------------------
// TASK 1 + 2: 403 WITHOUT challenge headers — verify a plain 403 is NOT
// misclassified as a challenge (it goes to forbidden_origin_or_token).
// ---------------------------------------------------------------------------

test('getServerIp: 403 without challenge headers and no challenge message is forbidden_origin_or_token', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_forbidden_plain';
    const CSRF_TOKEN = 'FAKE-CSRF-TOKEN_forbidden';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;

    logs = [];
    try {
        global.fetch = async (url) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 424242 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: CSRF_TOKEN }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                return {
                    ok: false,
                    status: 403,
                    statusMessage: 'Forbidden',
                    headers: makeMockHeaders({ csrf: CSRF_TOKEN, contentType: 'application/json' }),
                    json: async () => ({ errorMessage: 'You are not authorized to join this game.' })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-AAAA', { guildId: GUILD_ID, raidId: 42 });
        assert.equal(result, null);

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.httpStatus, 403);
        assert.equal(rec.challengeType, null, 'no challenge header in this response');
        assert.equal(rec.challengeHeadersPresent, false, 'challengeHeadersPresent must be false without the header');
        assert.equal(rec.challengeIdPresent, false);
        assert.equal(rec.challengeMetaPresent, false);
        assert.equal(rec.bodyJsonValid, true);
        assert.equal(rec.responseContentType, 'application/json');
        assert.equal(rec.blocker, 'forbidden_origin_or_token', 'a 403 without challenge must NOT be classified as roblox_challenge_required');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        restoreFetch();
    }
});

// ---------------------------------------------------------------------------
// TASK 6: successful GameJoin response with joinScript — verify location
// extraction and the absence of a blocker.
// ---------------------------------------------------------------------------

test('getServerIp: successful GameJoin with joinScript returns machine/public address + dataCenterId', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_success';
    const CSRF_TOKEN = 'FAKE-CSRF-TOKEN_success';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;

    logs = [];
    try {
        global.fetch = async (url) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 424242 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: CSRF_TOKEN }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                return {
                    ok: true,
                    status: 200,
                    statusMessage: 'OK',
                    headers: makeMockHeaders({ csrf: CSRF_TOKEN, contentType: 'application/json' }),
                    json: async () => ({
                        joinScript: {
                            MachineAddress: '10.0.0.1',
                            DataCenterId: 'dc-123',
                            UdmuxEndpoints: [{ Address: '203.0.113.1' }]
                        }
                    })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-AAAA', { guildId: GUILD_ID, raidId: 42 });
        assert.ok(result, 'must return a location object');
        assert.equal(result.machineAddress, '10.0.0.1');
        assert.equal(result.publicAddress, '203.0.113.1');
        assert.equal(result.dataCenterId, 'dc-123');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.httpStatus, 200);
        assert.equal(rec.joinScript, true);
        assert.equal(rec.blocker, null, 'successful join must have no blocker');
        assert.equal(rec.bodyJsonValid, true);
        assert.equal(rec.responseContentType, 'application/json');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        restoreFetch();
    }
});

// ---------------------------------------------------------------------------
// TASK 6: malformed response body — verify bodyJsonValid=false is recorded
// and the request still fails gracefully.
// ---------------------------------------------------------------------------

test('getServerIp: malformed (non-JSON) response body sets bodyJsonValid=false', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_malformed';
    const CSRF_TOKEN = 'FAKE-CSRF-TOKEN_malformed';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;

    logs = [];
    try {
        global.fetch = async (url) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 424242 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: CSRF_TOKEN }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                return {
                    ok: false,
                    status: 403,
                    statusMessage: 'Forbidden',
                    headers: makeMockHeaders({ csrf: CSRF_TOKEN, contentType: 'text/html' }),
                    json: async () => { throw new Error('Unexpected token < in JSON'); }
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-AAAA', { guildId: GUILD_ID, raidId: 42 });
        assert.equal(result, null, 'a malformed body must resolve to null');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.httpStatus, 403);
        assert.equal(rec.bodyJsonValid, false, 'bodyJsonValid must be false when JSON parsing fails');
        assert.equal(rec.responseContentType, 'text/html');
        assert.equal(rec.challengeType, null);
        assert.equal(rec.challengeHeadersPresent, false);
        assert.equal(rec.blocker, 'forbidden_origin_or_token', '403 without challenge headers and no parseable body = forbidden');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        restoreFetch();
    }
});

// ---------------------------------------------------------------------------
// fetchRobloxGameInstance: CSRF handshake (403 -> x-csrf-token -> one retry)
// + dynamic .ROBLOSECURITY refresh from Set-Cookie.
// ---------------------------------------------------------------------------

test('getServerIp: plain 403 with x-csrf-token retries once with the NEW token and adopts a rotated cookie', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_handshake';
    const PRE_TOKEN = 'FAKE-CSRF-PRE-PROBE';
    const HANDSHAKE_TOKEN = 'FAKE-CSRF-FROM-403-RESPONSE';
    const ROTATED_COOKIE = 'TEST_COOKIE_SECRET_rotated_never_log';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;

    const gamejoinCalls = [];
    logs = [];
    try {
        global.fetch = async (url, options) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 424242 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                // Pre-probe hands out a token that is deliberately DIFFERENT from
                // the one the 403 will rotate to, proving the retry uses the
                // extracted header value and not the stale pre-fetched one.
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: PRE_TOKEN }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                gamejoinCalls.push({ headers: (options && options.headers) || {} });
                if (gamejoinCalls.length === 1) {
                    // PLAIN 403 (no challenge header, no challenge message) with a
                    // rotated CSRF token -> must trigger exactly one retry.
                    return {
                        ok: false,
                        status: 403,
                        statusMessage: 'Forbidden',
                        headers: makeMockHeaders({ csrf: HANDSHAKE_TOKEN, contentType: 'application/json' }),
                        json: async () => ({ errorMessage: 'Token Validation Failed' })
                    };
                }
                // Retry succeeds and rotates .ROBLOSECURITY via Set-Cookie.
                return {
                    ok: true,
                    status: 200,
                    statusMessage: 'OK',
                    headers: makeMockHeaders({
                        csrf: HANDSHAKE_TOKEN,
                        contentType: 'application/json',
                        setCookie: [`.ROBLOSECURITY=${ROTATED_COOKIE}; domain=.roblox.com; path=/`]
                    }),
                    json: async () => ({
                        joinScript: { MachineAddress: '10.0.0.9', DataCenterId: 'dc-777', UdmuxEndpoints: [{ Address: '203.0.113.77' }] }
                    })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-HANDSHAKE', { guildId: GUILD_ID, raidId: 42 });
        assert.ok(result, 'the retried join must succeed');
        assert.equal(result.machineAddress, '10.0.0.9');
        assert.equal(result.publicAddress, '203.0.113.77');
        assert.equal(result.dataCenterId, 'dc-777');

        // Exactly one retry: the second POST must carry the token extracted from
        // the 403 response headers, not the pre-probed one.
        assert.equal(gamejoinCalls.length, 2, 'a plain 403 with a token must be retried exactly once');
        assert.equal(gamejoinCalls[0].headers['X-CSRF-TOKEN'], PRE_TOKEN);
        assert.equal(gamejoinCalls[1].headers['X-CSRF-TOKEN'], HANDSHAKE_TOKEN, 'retry must append the extracted x-csrf-token');
        // Cookie/Content-Type/User-Agent are always present on the gamejoin POST.
        for (const call of gamejoinCalls) {
            assert.equal(call.headers['Cookie'], `.ROBLOSECURITY=${COOKIE_SECRET}`);
            assert.equal(call.headers['Content-Type'], 'application/json');
            assert.equal(call.headers['User-Agent'], 'Roblox/WinInet');
        }

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.csrfRetried, true, 'the handshake retry must be recorded for /raiddebug');
        assert.equal(rec.httpStatus, 200);
        assert.equal(rec.joinScript, true);
        assert.equal(rec.blocker, null);

        // Requirement: the rotated token is retained for future requests.
        assert.equal(realRobloxAuth.BOT_COOKIE, ROTATED_COOKIE, 'rotated .ROBLOSECURITY must be adopted in memory');
        // ...and the rotated value must never leak into logs or diagnostics.
        const serialized = JSON.stringify(rec) + JSON.stringify(logs);
        assert.ok(!serialized.includes(COOKIE_SECRET), 'original cookie must never be logged');
        assert.ok(!serialized.includes(ROTATED_COOKIE), 'rotated cookie must never be logged');
        assert.ok(!serialized.includes(HANDSHAKE_TOKEN), 'CSRF token must never be logged');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        restoreFetch();
    }
});

// ---------------------------------------------------------------------------
// fetchRobloxGameInstance: 401 must surface the explicit auth error.
// ---------------------------------------------------------------------------

test('getServerIp: 401 returns null and logs the explicit revoked-cookie error', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_unauthorized';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;

    logs = [];
    try {
        global.fetch = async (url) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 424242 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: 'FAKE-CSRF-401' }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                return {
                    ok: false,
                    status: 401,
                    statusMessage: 'Unauthorized',
                    headers: makeMockHeaders({ contentType: 'application/json' }),
                    json: async () => ({ errorMessage: 'Unauthorized' })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-401', { guildId: GUILD_ID, raidId: 42 });
        assert.equal(result, null, 'getServerIp must keep its null-on-failure contract');

        const err = findLog(/\[Roblox Auth Error\] The \.ROBLOSECURITY cookie has been revoked or expired\./);
        assert.ok(err, 'the explicit revoked-cookie error must be logged');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.httpStatus, 401);
        assert.equal(rec.blocker, 'unauthorized_cookie');
        assert.ok(!JSON.stringify(rec).includes(COOKIE_SECRET), 'record must never contain the cookie value');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        restoreFetch();
    }
});

// ---------------------------------------------------------------------------
// ROBLOSECURITY_PROXY_URL: dispatcher binding (native fetch's httpsAgent equiv).
// ---------------------------------------------------------------------------

test('fetchRobloxGameInstance: ROBLOSECURITY_PROXY_URL binds a dispatcher on BOTH CSRF attempts', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_proxy';
    const PRE_TOKEN = 'FAKE-CSRF-PRE-PROBE-proxy';
    const HANDSHAKE_TOKEN = 'FAKE-CSRF-403-proxy';
    const ROTATED_COOKIE = 'TEST_COOKIE_SECRET_proxy_rotated';
    const PROXY_SECRET = 'http://user:pass@127.0.0.1:9999';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    const prevProxy = process.env.ROBLOSECURITY_PROXY_URL;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;
    process.env.ROBLOSECURITY_PROXY_URL = PROXY_SECRET;
    realRobloxAuth._resetProxyForTests();

    const calls = [];
    logs = [];
    try {
        global.fetch = async (url, options) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 1 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: PRE_TOKEN }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                calls.push(options || {});
                if (calls.length === 1) {
                    return {
                        ok: false, status: 403, statusMessage: 'Forbidden',
                        headers: makeMockHeaders({ csrf: HANDSHAKE_TOKEN, contentType: 'application/json' }),
                        json: async () => ({ errorMessage: 'Token Validation Failed' })
                    };
                }
                return {
                    ok: true, status: 200, statusMessage: 'OK',
                    headers: makeMockHeaders({
                        contentType: 'application/json',
                        setCookie: [`.ROBLOSECURITY=${ROTATED_COOKIE}; path=/`]
                    }),
                    json: async () => ({ joinScript: { MachineAddress: '10.0.0.5', DataCenterId: 'dc-9', UdmuxEndpoints: [{ Address: '203.0.113.9' }] } })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-PROXY', { guildId: GUILD_ID, raidId: 42 });

        // Core proxy assertions: the agent is bound on the initial POST AND the
        // 403 retry, and it is a single cached instance (socket pooling).
        assert.equal(calls.length, 2, 'expected initial POST + one CSRF retry');
        assert.ok(calls[0].dispatcher, 'dispatcher must be bound when ROBLOSECURITY_PROXY_URL is set');
        assert.ok(calls[1].dispatcher, 'the CSRF retry must reuse the proxy dispatcher');
        assert.equal(calls[0].dispatcher, calls[1].dispatcher, 'one agent instance must be reused, not rebuilt per request');

        // Core logic intact alongside the proxy: headers, retry token, payload.
        assert.equal(calls[0].headers['Cookie'], `.ROBLOSECURITY=${COOKIE_SECRET}`);
        assert.equal(calls[0].headers['User-Agent'], 'Roblox/WinInet');
        assert.equal(calls[0].headers['Content-Type'], 'application/json');
        assert.equal(calls[0].headers['X-CSRF-TOKEN'], PRE_TOKEN);
        assert.equal(calls[1].headers['X-CSRF-TOKEN'], HANDSHAKE_TOKEN, 'CSRF 403 retry must still fire through the proxy');
        assert.equal(result.machineAddress, '10.0.0.5');
        assert.equal(result.dataCenterId, 'dc-9');

        // Set-Cookie rotation must still be adopted through the proxy.
        assert.equal(realRobloxAuth.BOT_COOKIE, ROTATED_COOKIE, 'in-memory cookie rotation must still apply');

        // The proxy URL (which embeds user:pass) must never be logged.
        const serialized = JSON.stringify(logs);
        assert.ok(!serialized.includes('user:pass'), 'proxy credentials must never be logged');
        assert.ok(!serialized.includes(PROXY_SECRET), 'proxy URL must never be logged');
        assert.ok(findLog(/proxy enabled scheme=http: auth=true/), 'a sanitized proxy-enabled line must be logged');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.proxyEnabled, true, 'diagnostics must record that the proxied path was used');
        assert.equal(rec.csrfRetried, true);
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        if (prevProxy === undefined) delete process.env.ROBLOSECURITY_PROXY_URL;
        else process.env.ROBLOSECURITY_PROXY_URL = prevProxy;
        realRobloxAuth._resetProxyForTests();
        restoreFetch();
    }
});

test('fetchRobloxGameInstance: no ROBLOSECURITY_PROXY_URL falls back to direct with ONE warning', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_noproxy';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    const prevProxy = process.env.ROBLOSECURITY_PROXY_URL;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;
    delete process.env.ROBLOSECURITY_PROXY_URL;
    realRobloxAuth._resetProxyForTests();

    const calls = [];
    logs = [];
    try {
        global.fetch = async (url, options) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 1 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: 'FAKE-CSRF-NO-PROXY' }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                calls.push(options || {});
                return {
                    ok: true, status: 200, statusMessage: 'OK',
                    headers: makeMockHeaders({ contentType: 'application/json' }),
                    json: async () => ({ joinScript: { MachineAddress: '10.0.0.6', DataCenterId: 'dc-10', UdmuxEndpoints: [{ Address: '203.0.113.10' }] } })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-NO-PROXY', { guildId: GUILD_ID, raidId: 42 });

        assert.ok(result, 'direct path must keep working');
        assert.ok(calls.length >= 1);
        // No `dispatcher` key at all => byte-identical direct egress.
        assert.equal('dispatcher' in calls[0], false, 'dispatcher must be omitted entirely when no proxy is configured');

        // The warning must be emitted exactly once, not per request/resolution.
        const warns = logs.filter(l => /ROBLOSECURITY_PROXY_URL is not set/.test(l.args.join(' ')));
        assert.equal(warns.length, 1, 'missing-proxy warning must be logged exactly once');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.proxyEnabled, false, 'diagnostics must record direct egress');
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        if (prevProxy === undefined) delete process.env.ROBLOSECURITY_PROXY_URL;
        else process.env.ROBLOSECURITY_PROXY_URL = prevProxy;
        realRobloxAuth._resetProxyForTests();
        restoreFetch();
    }
});

test('fetchRobloxGameInstance: an unparseable proxy URL degrades to direct and never logs the value', async () => {
    const COOKIE_SECRET = 'TEST_COOKIE_SECRET_badproxy';
    const BAD_PROXY = 'definitely-not-a-valid-proxy-url';
    const prevCookie = process.env.BOT_ROBLOSECURITY;
    const prevProxy = process.env.ROBLOSECURITY_PROXY_URL;
    process.env.BOT_ROBLOSECURITY = COOKIE_SECRET;
    process.env.ROBLOSECURITY_PROXY_URL = BAD_PROXY;
    realRobloxAuth._resetProxyForTests();

    const calls = [];
    logs = [];
    try {
        global.fetch = async (url, options) => {
            const u = String(url);
            if (u.includes('users.roblox.com')) {
                return { ok: true, status: 200, headers: makeMockHeaders({}), json: async () => ({ id: 1 }) };
            }
            if (u.includes('auth.roblox.com/v2/logout')) {
                return { ok: true, status: 403, headers: makeMockHeaders({ csrf: 'FAKE-CSRF-BAD-PROXY' }), json: async () => ({}) };
            }
            if (u.includes('gamejoin.roblox.com')) {
                calls.push(options || {});
                return {
                    ok: true, status: 200, statusMessage: 'OK',
                    headers: makeMockHeaders({ contentType: 'application/json' }),
                    json: async () => ({ joinScript: { MachineAddress: '10.0.0.7', DataCenterId: 'dc-11', UdmuxEndpoints: [{ Address: '203.0.113.11' }] } })
                };
            }
            throw new Error(`unexpected fetch in test: ${u}`);
        };

        const result = await realRobloxAuth.getServerIp('10449761463', 'JOB-BAD-PROXY', { guildId: GUILD_ID, raidId: 42 });

        assert.ok(result, 'an invalid proxy config must not break the join');
        assert.equal('dispatcher' in calls[0], false, 'invalid proxy must degrade to direct egress');
        assert.ok(findLog(/ROBLOSECURITY_PROXY_URL failed to parse/), 'the parse failure must be surfaced');
        assert.ok(!JSON.stringify(logs).includes(BAD_PROXY), 'the invalid value must never be logged');

        const rec = realRobloxAuth.getLastGameJoinAttempt();
        assert.ok(rec);
        assert.equal(rec.proxyEnabled, false);
    } finally {
        if (prevCookie === undefined) delete process.env.BOT_ROBLOSECURITY;
        else process.env.BOT_ROBLOSECURITY = prevCookie;
        if (prevProxy === undefined) delete process.env.ROBLOSECURITY_PROXY_URL;
        else process.env.ROBLOSECURITY_PROXY_URL = prevProxy;
        realRobloxAuth._resetProxyForTests();
        restoreFetch();
    }
});
