const test = require('node:test');
const assert = require('assert');

// --- Mock sharedPingDb BEFORE requiring interactionCreate ---
// getRaidPingInfo calls sharedPingDb.getGuildPingSettings(guildId) which
// returns { countryPings, regionPings }. We replace it with a controllable mock.
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

const { lookupCaseInsensitive, pickRoleId, getRaidPingInfo } = require('../events/interactionCreate');

// Helper: build a minimal mock Discord client + guild for roleExistsInGuild.
function makeMockClient(guildId, roleIds) {
    const roles = {
        cache: new Map(roleIds.map(id => [id, { id, name: 'ping-role' }])),
        fetch: async (id) => roleIds.includes(id) ? { id } : null
    };
    return {
        guilds: {
            cache: new Map([[guildId, { id: guildId, roles }]])
        }
    };
}

// Helper: set the mock sharedPingDb return value for a single test.
function setMockConfig(cfg) {
    MOCK_SHARED_PING_DB.getGuildPingSettings = async () => cfg;
}

// Silence the diagnostic console.warn during tests that expect no ping.
const realWarn = console.warn;
function silenceWarn() { console.warn = () => {}; }
function restoreWarn() { console.warn = realWarn; }

const GUILD_ID = '111111111111111111';
const ROLE_ID = '222222222222222222';

// ===========================================================================
// lookupCaseInsensitive
// ===========================================================================

test('lookupCaseInsensitive: exact key match (fast path)', () => {
    const obj = { 'IN': 'role-1', 'EU': 'role-2' };
    assert.strictEqual(lookupCaseInsensitive(obj, 'IN'), 'role-1');
    assert.strictEqual(lookupCaseInsensitive(obj, 'EU'), 'role-2');
});

test('lookupCaseInsensitive: lowercase key matches uppercase query', () => {
    const obj = { 'in': 'role-1', 'eu': 'role-2' };
    assert.strictEqual(lookupCaseInsensitive(obj, 'IN'), 'role-1');
    assert.strictEqual(lookupCaseInsensitive(obj, 'EU'), 'role-2');
});

test('lookupCaseInsensitive: mixed-case key matches uppercase query', () => {
    const obj = { 'In': 'role-1', 'Eu': 'role-2' };
    assert.strictEqual(lookupCaseInsensitive(obj, 'IN'), 'role-1');
    assert.strictEqual(lookupCaseInsensitive(obj, 'EU'), 'role-2');
});

test('lookupCaseInsensitive: no match returns undefined', () => {
    const obj = { 'IN': 'role-1' };
    assert.strictEqual(lookupCaseInsensitive(obj, 'SG'), undefined);
});

test('lookupCaseInsensitive: null/undefined/empty object returns undefined', () => {
    assert.strictEqual(lookupCaseInsensitive(null, 'IN'), undefined);
    assert.strictEqual(lookupCaseInsensitive(undefined, 'IN'), undefined);
    assert.strictEqual(lookupCaseInsensitive({}, 'IN'), undefined);
});

test('lookupCaseInsensitive: empty/whitespace search key returns undefined', () => {
    const obj = { 'IN': 'role-1' };
    assert.strictEqual(lookupCaseInsensitive(obj, ''), undefined);
    assert.strictEqual(lookupCaseInsensitive(obj, '  '), undefined);
});

test('lookupCaseInsensitive: preserves the value type (e.g. array)', () => {
    const arr = ['123', '456'];
    const obj = { 'IN': arr };
    assert.strictEqual(lookupCaseInsensitive(obj, 'IN'), arr);
});

// ===========================================================================
// pickRoleId
// ===========================================================================

test('pickRoleId: string role id', () => {
    assert.strictEqual(pickRoleId('123456789012345678'), '123456789012345678');
});

test('pickRoleId: numeric role id is coerced to string', () => {
    // JSONB can return numbers; this coercion handles that path.
    assert.strictEqual(pickRoleId(123456), '123456');
});

test('pickRoleId: array picks first element', () => {
    assert.strictEqual(pickRoleId(['123456789012345678', '987654321098765432']), '123456789012345678');
});

test('pickRoleId: array with empty first element is rejected', () => {
    assert.strictEqual(pickRoleId(['', '987654321098789']), null);
    assert.strictEqual(pickRoleId([null, '987654321098789']), null);
});

test('pickRoleId: null/undefined/empty/zero/@everyone returns null', () => {
    assert.strictEqual(pickRoleId(null), null);
    assert.strictEqual(pickRoleId(undefined), null);
    assert.strictEqual(pickRoleId(''), null);
    assert.strictEqual(pickRoleId('0'), null);
    assert.strictEqual(pickRoleId('@everyone'), null);
    assert.strictEqual(pickRoleId(0), null);
});

test('pickRoleId: trims whitespace around string ids', () => {
    assert.strictEqual(pickRoleId('  123456789  '), '123456789');
});

// ===========================================================================
// getRaidPingInfo integration (mocked sharedPingDb + mock client)
// ===========================================================================

test('getRaidPingInfo: country code match returns role mention + allowedMentions', async () => {
    setMockConfig({ countryPings: { 'IN': ROLE_ID }, regionPings: {} });
    const client = makeMockClient(GUILD_ID, [ROLE_ID]);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: 'IN', region: 'ASIA' });
    assert.strictEqual(info.roleId, ROLE_ID);
    assert.strictEqual(info.mention, '<@&' + ROLE_ID + '>');
    assert.deepStrictEqual(info.allowedMentions, { roles: [ROLE_ID] });
    assert.strictEqual(info.source, 'country');
});

test('getRaidPingInfo: case-insensitive country code lookup (dashboard stores lowercase)', async () => {
    setMockConfig({ countryPings: { 'in': ROLE_ID }, regionPings: {} });
    const client = makeMockClient(GUILD_ID, [ROLE_ID]);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: 'IN', region: 'ASIA' });
    assert.strictEqual(info.roleId, ROLE_ID);
    assert.strictEqual(info.source, 'country');
});

test('getRaidPingInfo: region fallback when only region pings configured', async () => {
    // Country code detected but only region pings configured — the FIX that
    // makes region-only dashboard configs actually produce a location ping.
    setMockConfig({ countryPings: {}, regionPings: { 'ASIA': ROLE_ID } });
    const client = makeMockClient(GUILD_ID, [ROLE_ID]);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: 'IN', region: 'ASIA' });
    assert.strictEqual(info.roleId, ROLE_ID);
    assert.strictEqual(info.mention, '<@&' + ROLE_ID + '>');
    assert.strictEqual(info.source, 'region');
});

test('getRaidPingInfo: no country code, region match returns role', async () => {
    setMockConfig({ countryPings: {}, regionPings: { 'EU': ROLE_ID } });
    const client = makeMockClient(GUILD_ID, [ROLE_ID]);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: null, region: 'EU' });
    assert.strictEqual(info.roleId, ROLE_ID);
    assert.strictEqual(info.source, 'region');
});

test('getRaidPingInfo: case-insensitive region lookup', async () => {
    setMockConfig({ countryPings: {}, regionPings: { 'asia': ROLE_ID } });
    const client = makeMockClient(GUILD_ID, [ROLE_ID]);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: null, region: 'ASIA' });
    assert.strictEqual(info.roleId, ROLE_ID);
    assert.strictEqual(info.source, 'region');
});

test('getRaidPingInfo: numeric role id from JSONB is coerced to string', async () => {
    // Small numeric values (within Number.MAX_SAFE_INTEGER) are coerced to
    // string. (Discord snowflakes are 19 digits and MUST be stored as strings
    // by the dashboard — JSONB numbers lose precision for large snowflakes.)
    setMockConfig({ countryPings: { 'SG': 123456 }, regionPings: {} });
    const client = makeMockClient(GUILD_ID, ['123456']);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: 'SG', region: 'ASIA' });
    assert.strictEqual(info.roleId, '123456');
    assert.strictEqual(info.source, 'country');
});

test('getRaidPingInfo: no matching role returns source none', async () => {
    silenceWarn();
    setMockConfig({ countryPings: {}, regionPings: {} });
    const client = makeMockClient(GUILD_ID, []);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: 'IN', region: 'ASIA' });
    restoreWarn();
    assert.strictEqual(info.roleId, null);
    assert.strictEqual(info.mention, null);
    assert.strictEqual(info.allowedMentions, undefined);
    assert.strictEqual(info.source, 'none');
});

test('getRaidPingInfo: country ping preferred over region when both configured', async () => {
    silenceWarn();
    setMockConfig({
        countryPings: { 'IN': 'country-role-id' },
        regionPings: { 'ASIA': 'region-role-id' }
    });
    const client = makeMockClient(GUILD_ID, ['country-role-id', 'region-role-id']);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: 'IN', region: 'ASIA' });
    assert.strictEqual(info.roleId, 'country-role-id');
    assert.strictEqual(info.source, 'country');
    restoreWarn();
});

test('getRaidPingInfo: deleted country role falls back to configured region role', async () => {
    // Country role configured in Postgres but the role was deleted from the
    // guild; the region fallback should pick up the region role instead.
    setMockConfig({
        countryPings: { 'IN': '999999999999999999' },
        regionPings: { 'ASIA': ROLE_ID }
    });
    const client = makeMockClient(GUILD_ID, [ROLE_ID]);
    const info = await getRaidPingInfo(client, GUILD_ID, { countryCode: 'IN', region: 'ASIA' });
    assert.strictEqual(info.roleId, ROLE_ID);
    assert.strictEqual(info.source, 'region');
});
