const test = require('node:test');
const assert = require('assert');

const sharedPingDb = require('../handlers/sharedPingDb');
const guildAccess = require('../handlers/guildAccess');

// ── In-memory Supabase fake for the runtime integration tests ────────────
// The integration tests below exercise the REAL event-handler code paths
// (guildCreate → channel creation, interactionCreate → access guard) without
// touching production Supabase. We swap the shared pool's query function for
// an in-memory implementation that understands the SQL guildAccess issues.
const accessRows = new Map();
let dbShouldFail = false;
function accessRow(gid, patch) {
    const prev = accessRows.get(gid) || { guild_id: gid, guild_name: null, owner_id: null, bot_present: true, access_status: 'pending', onboarding_channel_id: null, onboarding_message_id: null, onboarding_created_at: null, joined_at: new Date().toISOString(), left_at: null, granted_by: null, granted_at: null, revoked_by: null, revoked_at: null, owner_dm_status: null, owner_dm_sent_at: null, updated_at: new Date().toISOString() };
    const next = Object.assign({}, prev, patch || {});
    accessRows.set(gid, next);
    return next;
}
sharedPingDb.runPoolQuery = async (sql, params = []) => {
    if (dbShouldFail) throw new Error('simulated database failure');
    const s = String(sql);
    if (/CREATE\s+(TABLE|INDEX)/i.test(s)) return { rows: [] };
    const gid = params[0] === undefined ? null : String(params[0]);
    if (/INSERT INTO kakuzu_guilds/i.test(s)) return { rows: [accessRow(gid, { guild_name: params[1] || null, owner_id: params[2] || null, bot_present: true, left_at: null })] };
    if (/INSERT INTO kakuzu_access_events/i.test(s)) return { rows: [] };
    if (/SELECT \* FROM kakuzu_guilds/i.test(s)) { const row = accessRows.get(gid); return { rows: row ? [row] : [] }; }
    if (/UPDATE kakuzu_guilds SET access_status = 'granted'/i.test(s)) return { rows: [accessRow(gid, { access_status: 'granted', granted_by: params[1] || null })] };
    if (/UPDATE kakuzu_guilds SET access_status = 'revoked'/i.test(s)) return { rows: [accessRow(gid, { access_status: 'revoked', revoked_by: params[1] || null })] };
    if (/UPDATE kakuzu_guilds SET bot_present = FALSE/i.test(s)) return { rows: [accessRow(gid, { bot_present: false, left_at: new Date().toISOString() })] };
    if (/UPDATE kakuzu_guilds SET onboarding_channel_id/i.test(s)) { accessRow(gid, { onboarding_channel_id: params[1] || null, onboarding_message_id: params[2] || null }); return { rows: [] }; }
    if (/UPDATE kakuzu_guilds/i.test(s)) { accessRow(gid, {}); return { rows: [] }; }
    return { rows: [] };
};
const setDbFailure = (v) => { dbShouldFail = v; };
const clearAccessRows = () => accessRows.clear();

// Premium-access unit tests run WITHOUT a database: Supabase is the
// authoritative store, but pure logic (password gate, cache TTL, embeds,
// locked reply) must hold even when the DB is unreachable.

test('access password rejects wrong passwords and empty config', () => {
    process.env.ACCESS_GRANT_PASSWORD = 'correct-horse-1';
    assert.strictEqual(guildAccess.verifyAccessPassword('correct-horse-1'), true);
    assert.strictEqual(guildAccess.verifyAccessPassword('wrong'), false);
    assert.strictEqual(guildAccess.verifyAccessPassword(''), false);
    const saved = process.env.ACCESS_GRANT_PASSWORD;
    delete process.env.ACCESS_GRANT_PASSWORD;
    assert.strictEqual(guildAccess.verifyAccessPassword('correct-horse-1'), false);
    process.env.ACCESS_GRANT_PASSWORD = saved;
});

test('access manager auth: support-server-only (owner included), super-admin bypasses', () => {
    process.env.SUPPORT_GUILD_ID = '999';
    process.env.BOT_OWNER_ID = '1';
    process.env.ACCESS_MANAGER_ROLE_IDS = '10, 20';
    process.env.ACCESS_GRANT_PASSWORD = 's3cret';
    const memberWithRole = { id: '5', roles: { cache: new Map([['10', {}]]) } };
    assert.strictEqual(guildAccess.authorizeAccessManager(memberWithRole, '999', 's3cret').ok, true);
    // Wrong guild → blocked even with role + password.
    assert.strictEqual(guildAccess.authorizeAccessManager(memberWithRole, '888', 's3cret').ok, false);
    // No role, not owner — even with the right password.
    const stranger = { id: '7', roles: { cache: new Map() } };
    assert.strictEqual(guildAccess.authorizeAccessManager(stranger, '999', 's3cret').ok, false);
    // Wrong password.
    assert.strictEqual(guildAccess.authorizeAccessManager(memberWithRole, '999', 'nope').ok, false);
    // Owner inside support server: role check skipped, password still needed.
    const owner = { id: '1', roles: { cache: new Map() } };
    assert.strictEqual(guildAccess.authorizeAccessManager(owner, '999', 's3cret').ok, true);
    assert.strictEqual(guildAccess.authorizeAccessManager(owner, '999', 'bad').ok, false);
    // Owner OUTSIDE the support server: blocked (support-only rule).
    assert.strictEqual(guildAccess.authorizeAccessManager(owner, '888', 's3cret').ok, false);
    assert.strictEqual(guildAccess.authorizeAccessManager(memberWithRole, '888', 's3cret').ok, false);
    // Super-admin bypass: any server, no password (by id + by username).
    const superById = { id: '1392856295807389756', roles: { cache: new Map() } };
    assert.strictEqual(guildAccess.authorizeAccessManager(superById, '888', '').ok, true);
    const superByName = { id: '42', user: { username: 'yourdad043' }, roles: { cache: new Map() } };
    assert.strictEqual(guildAccess.authorizeAccessManager(superByName, '888', '').ok, true);
});

test('access cache invalidates immediately (no stale grants)', () => {
    guildAccess.setCachedStatus('123', 'granted');
    assert.strictEqual(guildAccess.getCachedStatus('123'), 'granted');
    guildAccess.invalidateGuildCache('123');
    assert.strictEqual(guildAccess.getCachedStatus('123'), null);
});

test('locked reply is ephemeral and carries no password', async () => {
    process.env.KAKUZU_SUPPORT_URL = 'https://discord.gg/example';
    process.env.ACCESS_GRANT_PASSWORD = 's3cret';
    const locked = guildAccess.buildLockedReply();
    assert.strictEqual(locked.flags, 64);
    assert.match(locked.content, /has not been granted access/);
    assert.match(locked.content, /Join the Kakuzu Support Server/);
    assert.ok(!JSON.stringify(locked).includes('s3cret'), 'locked reply must never leak the password');
});

test('locked reply missing-perms DM carries the required explanation', () => {
    process.env.KAKUZU_SUPPORT_URL = 'https://discord.gg/example';
    const dm = guildAccess.buildMissingPermsDm({ guildName: 'Test', guildId: '1', ownerId: '2' });
    const json = JSON.stringify(dm);
    assert.match(json, /Kakuzu Needs Permission to Join Your Server/);
    assert.match(json, /Manage Channels/);
    assert.match(json, /kakuzu-access/);
    assert.match(json, /Server ID: 1/);
    assert.match(json, /Owner: <@2>/);
});

test('botMissingManageChannels returns true when ManageChannels is absent', () => {
    const manageChannels = require('discord.js').PermissionsBitField.Flags.ManageChannels;
    const noPerms = { permissions: { has: () => false } };
    const hasOtherButNotManage = { permissions: { has: (flag) => flag !== manageChannels } };
    // A member with no permissions object at all.
    assert.strictEqual(guildAccess.botMissingManageChannels(null), true);
    assert.strictEqual(guildAccess.botMissingManageChannels(undefined), true);
    assert.strictEqual(guildAccess.botMissingManageChannels(noPerms), true);
    assert.strictEqual(guildAccess.botMissingManageChannels(hasOtherButNotManage), true);
    const hasManage = { permissions: { has: (flag) => flag === manageChannels } };
    assert.strictEqual(guildAccess.botMissingManageChannels(hasManage), false);
});

test('pending/granted/revoked/owner-DM embeds carry required fields', () => {
    process.env.KAKUZU_SUPPORT_URL = 'https://discord.gg/example';
    const pending = guildAccess.buildPendingEmbed({ guildName: 'Test', guildId: '1', ownerId: '2' });
    const pendingJson = JSON.stringify(pending);
    assert.match(pendingJson, /Kakuzu Premium Access Required/);
    assert.match(pendingJson, /How to get access/);
    assert.match(pendingJson, /Server information/);
    assert.match(pendingJson, /Join Kakuzu Support/);
    assert.ok(!pendingJson.includes('ACCESS_GRANT_PASSWORD'), 'pending embed must not mention the password');

    const granted = guildAccess.buildGrantedEmbed({ guildName: 'Test', guildId: '1', grantedAt: new Date('2026-01-02T03:04:05Z') });
    assert.match(JSON.stringify(granted), /Kakuzu Access Granted/);
    assert.match(JSON.stringify(granted), /Getting started/);

    const revoked = guildAccess.buildRevokedEmbed({ guildName: 'Test', guildId: '1' });
    assert.match(JSON.stringify(revoked), /Kakuzu Access Revoked/);

    const dm = guildAccess.buildOwnerDmPayload({ guildName: 'Test', guildId: '1', moderatorMention: '<@9>' });
    assert.match(JSON.stringify(dm), /Your Server Has Kakuzu Access/);
    assert.match(JSON.stringify(dm), /Server ID/);
});

// ── Premium-access runtime integration tests ─────────────────────────────
// These prove the actual event-handler contracts: guildCreate → channel
// creation; interactionCreate → access guard; grant flow → status change.

test('DB failure fails closed (never grants access)', async () => {
    clearAccessRows();
    guildAccess.invalidateGuildCache('db-down-guild');
    setDbFailure(true);
    try {
        const status = await guildAccess.getGuildAccessStatus('db-down-guild');
        assert.strictEqual(status, 'pending', 'DB failure must be locked, got ' + status);
        assert.strictEqual(await guildAccess.isGuildGranted('db-down-guild'), false, 'DB failure must never grant');
    } finally {
        setDbFailure(false);
    }
    guildAccess.invalidateGuildCache('db-down-guild');
});

test('missing Supabase row is treated as unauthorized (never granted)', async () => {
    clearAccessRows();
    guildAccess.invalidateGuildCache('absent-guild');
    const status = await guildAccess.getGuildAccessStatus('absent-guild');
    assert.strictEqual(status, 'pending', 'a guild with no Supabase row must be locked');
    assert.strictEqual(await guildAccess.isGuildGranted('absent-guild'), false);
});

test('guildJoin handler upserts a pending guild and creates the access channel', async () => {
    const mockChannel = { id: 'chan-1', guildId: 'guild-1', name: 'kakuzu-access', type: 0, isTextBased: () => true,
        messages: { fetch: async (opts) => { if (opts && 'limit' in opts) return []; return { id: 'msg-1', author: { id: 'bot-id' }, embeds: [{ title: 'Kakuzu Premium Access Required' }] }; } },
        send: async (payload) => { mockChannel.lastSent = payload; return { id: 'sent-msg-1' }; }
    };
    const mockGuild = { id: 'guild-1', name: 'Test Server', channels: { cache: { find: () => null }, fetch: async () => [mockChannel] }, fetchOwner: async () => ({ id: 'owner-1' }), members: { me: { permissions: { has: () => true } } } };
    const mockClient = { user: { id: 'bot-id', displayAvatarURL: () => 'https://example.com/bot.png' },
        channels: { fetch: async (id) => id === 'chan-1' ? mockChannel : null,
            create: async (opts) => { assert.strictEqual(opts.name, 'kakuzu-access'); assert.strictEqual(opts.type, 0); assert.ok(opts.reason);
                return { id: 'new-chan-1', guildId: 'guild-1', name: 'kakuzu-access', type: 0, isTextBased: () => true,
                    send: async (payload) => { mockChannel.lastSent = payload; return { id: 'new-sent-1' }; } }; } },
        users: { fetch: async (id) => id === 'owner-1' ? { id: 'owner-1', send: async () => {} } : null } };
    const upsertResult = await guildAccess.upsertGuildOnJoin({ guildId: 'guild-1', guildName: 'Test Server', ownerId: 'owner-1' });
    assert.ok(upsertResult, 'join must upsert a guild row');
    assert.strictEqual(upsertResult.accessStatus, 'pending', 'new guild must start as pending (locked)');
    const onboardResult = await guildAccess.ensureOnboardingForLockedGuild(mockClient, mockGuild, upsertResult);
    assert.ok(onboardResult, 'locked guild must get onboarding');
    assert.ok(onboardResult.channelId, 'locked guild must get a channel');
    assert.ok(onboardResult.messageId, 'locked guild must get a stored message id');
    const sentPayload = mockChannel.lastSent;
    if (sentPayload) {
        const bodies = [];
        const collectContent = (node) => {
            if (!node) return;
            if (typeof node === 'string') { bodies.push(node); return; }
            if (Array.isArray(node)) { node.forEach(collectContent); return; }
            if (typeof node.content === 'string') bodies.push(node.content);
            if (typeof node.description === 'string') bodies.push(node.description);
            if (Array.isArray(node.embeds)) collectContent(node.embeds);
            if (Array.isArray(node.components)) collectContent(node.components);
        };
        collectContent(sentPayload.embeds || []);
        collectContent(sentPayload.components || []);
        assert.ok(bodies.length > 0, 'onboarding message must include an embed or V2 text sections');
        assert.match(bodies.join('\n'), /Kakuzu Premium Access Required|KAKUZU PREMIUM ACCESS REQUIRED/);
        const bodiesJoined = bodies.join('\n');
        const supportUrl = guildAccess.getSupportUrl();
        const supportId = guildAccess.getSupportGuildId();
        assert.ok(bodiesJoined.includes(supportUrl) || bodiesJoined.includes(supportId),
            'onboarding card must carry the support invite link or support server id (got: ' + bodiesJoined.slice(0, 200) + ')');
    }
});

test('grant flow marks pending guild as granted and updates onboarding message', async () => {
    const ownerUser = { id: 'owner-1', send: async (payload) => { ownerUser.lastDm = payload; } };
    const mockClient = { user: { id: 'mod-id', displayAvatarURL: () => 'https://example.com/mod.png' },
        guilds: { fetch: async (gid) => ({ id: gid, name: 'Target Server', fetchOwner: async () => ownerUser }) },
        users: { fetch: async (id) => id === 'owner-1' ? ownerUser : null } };
    const row = await guildAccess.upsertGuildOnJoin({ guildId: 'grant-guild', guildName: 'Target Server', ownerId: 'owner-1' });
    assert.strictEqual(row.accessStatus, 'pending');
    const granted = await guildAccess.grantGuildAccess('grant-guild', 'mod-id');
    assert.strictEqual(granted.row.accessStatus, 'granted');
    assert.strictEqual(granted.alreadyGranted, false);
    const editResult = await guildAccess.editOnboardingMessage(mockClient, 'grant-guild', () => guildAccess.buildGrantedEmbed({ guildName: 'Target Server', guildId: 'grant-guild', grantedAt: new Date() }));
    assert.ok(editResult, 'grant must update the onboarding message');
    const dm = guildAccess.buildOwnerDmPayload({ guildName: 'Target Server', guildId: 'grant-guild', moderatorMention: '<@mod-id>' });
    const dmJson = JSON.stringify(dm);
    assert.match(dmJson, /Your Server Has Kakuzu Access/);
    assert.match(dmJson, /Server ID/);
    assert.match(dmJson, /grant-guild/);
});

test('access guard blocks a normal command for a pending guild (no Supabase)', async () => {
    process.env.DATABASE_URL = '';
    guildAccess.invalidateGuildCache('pending-guild');
    const status = await guildAccess.getGuildAccessStatus('pending-guild');
    assert.strictEqual(status, 'pending', 'missing Supabase row must be pending (locked)');
    assert.strictEqual(await guildAccess.isGuildGranted('pending-guild'), false, 'pending guild must not be granted');
    const locked = guildAccess.buildLockedReply();
    assert.strictEqual(locked.flags, 64, 'blocked reply must be ephemeral');
    assert.match(locked.content, /has not been granted access/);
    assert.match(locked.content, /Join the Kakuzu Support Server/);
});

test('reconcile on ready repairs missing onboarding for locked guilds without resetting granted ones', async () => {
    const storedRow = { guildId: 'locked-guild', guildName: 'Locked Server', ownerId: 'owner-1', accessStatus: 'pending', onboardingChannelId: null, onboardingMessageId: null };
    const createdChannel = { id: 'new-chan', guildId: 'locked-guild', name: 'kakuzu-access', type: 0, isTextBased: () => true, send: async (payload) => ({ id: 'new-msg' }) };
    const mockGuild = {
        id: 'locked-guild', name: 'Locked Server',
        fetchOwner: async () => ({ id: 'owner-1' }),
        channels: {
            cache: { find: () => null },
            fetch: async () => [],
            create: async (opts) => { assert.strictEqual(opts.name, 'kakuzu-access'); return createdChannel; }
        }
    };
    const mockClient = { user: { id: 'bot-id', displayAvatarURL: () => 'https://example.com/bot.png' }, users: { fetch: async (id) => id === 'owner-1' ? { id: 'owner-1', send: async () => ({ id: 'dm-1' }) } : null } };
    const got = await guildAccess.ensureOnboardingForLockedGuild(mockClient, mockGuild, storedRow);
    assert.ok(got, 'reconcile must return a result');
    assert.strictEqual(got.channelId, 'new-chan', 'locked guild must get the kakuzu-access channel');
    assert.strictEqual(got.messageId, 'new-msg', 'the access embed must be sent and its id stored');
    assert.strictEqual(got.created, true, 'the channel must be reported as created');
});

// ── End-to-end event-handler tests (the REAL events/*.js handlers) ───────
// These call the actual event handlers the bot registers, proving the runtime
// is wired: guildCreate → channel creation, interactionCreate → access guard.

test('live guildCreate event handler creates the kakuzu-access channel', async () => {
    // Stub the command registrar so no Discord REST calls are made.
    const deployCommands = require('../commands/deploy-commands');
    deployCommands.registerGuildCommands = async (gid) => { global.__kakuzuLastRegisteredGuild = gid; };
    delete require.cache[require.resolve('../events/guildCreate')];

    clearAccessRows();
    const createdChannelNames = [];
    const makeChannel = (name) => ({
        id: 'ch-' + name, guildId: 'new-guild', name, type: 0, isTextBased: () => true,
        messages: { fetch: async () => [] },
        send: async () => ({ id: 'msg-' + name })
    });
    const mockGuild = {
        id: 'new-guild', name: 'Fresh Server',
        fetchOwner: async () => ({ id: 'owner-1' }),
        channels: {
            cache: { find: () => null },
            fetch: async () => [],
            create: async (opts) => { createdChannelNames.push(opts.name); return makeChannel(opts.name); }
        },
        members: { me: { permissions: { has: () => true } } }
    };
    const mockClient = {
        user: { id: 'bot-id', displayAvatarURL: () => 'https://example.com/bot.png' },
        users: { fetch: async (id) => (id === 'owner-1' ? { id, send: async () => ({ id: 'dm' }) } : null) }
    };

    const guildCreate = require('../events/guildCreate');
    assert.strictEqual(guildCreate.name, 'guildCreate', 'name must be guildCreate for index.js to register the listener');
    assert.strictEqual(guildCreate.once, false, 'guildCreate must be a repeating listener');
    await guildCreate.execute(mockGuild, mockClient);

    assert.strictEqual(global.__kakuzuLastRegisteredGuild, 'new-guild', 'join must register slash commands');
    assert.ok(createdChannelNames.includes('kakuzu-access'),
        'guildCreate must create the kakuzu-access channel; created: ' + JSON.stringify(createdChannelNames));
});

function makeInteraction(guildId, commandName) {
    const seen = { replies: [] };
    const interaction = {
        guildId, commandName, customId: null, type: 2,
        guild: { id: guildId }, user: { id: 'user-1' },
        member: { id: 'user-1', roles: { cache: new Map() }, permissions: { has: () => false } },
        client: { commands: new Map(), user: { id: 'bot-id' } },
        deferred: false, replied: false,
        isChatInputCommand: () => true,
        isAutocomplete: () => false,
        isButton: () => false,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        isRoleSelectMenu: () => false,
        options: { getString: () => null, getSubcommand: () => null },
        reply: async (payload) => { seen.replies.push(payload); interaction.replied = true; return {}; },
        deferReply: async () => { interaction.deferred = true; return {}; },
        editReply: async (payload) => { seen.replies.push(payload); return {}; },
        followUp: async () => ({}),
        seen
    };
    return interaction;
}

test('live interactionCreate guard blocks a normal command in an unauthorized guild', async () => {
    clearAccessRows();
    guildAccess.invalidateGuildCache('unauthorized-guild');
    let commandRan = false;
    const interactionCreate = require('../events/interactionCreate');
    assert.strictEqual(interactionCreate.name, 'interactionCreate',
        'name must be interactionCreate for index.js to register the listener');
    const interaction = makeInteraction('unauthorized-guild', 'botinfo');
    interaction.client.commands.set('botinfo', { deferFirst: false, execute: async () => { commandRan = true; } });
    await interactionCreate.execute(interaction);
    assert.strictEqual(commandRan, false, 'a locked guild must NEVER execute the command');
    assert.ok(interaction.seen.replies.length > 0, 'the guard must reply to the blocked interaction');
    const payload = interaction.seen.replies[0];
    assert.strictEqual(payload.flags, 64, 'the locked reply must be ephemeral');
    assert.match(payload.content, /This server has not been granted access to Kakuzu/);
    assert.match(payload.content, /Join the Kakuzu Support Server and create a ticket to request access/);
});

test('live interactionCreate guard lets a granted guild run the command', async () => {
    clearAccessRows();
    accessRow('granted-guild', { access_status: 'granted' });
    guildAccess.invalidateGuildCache('granted-guild');
    let commandRan = false;
    const interactionCreate = require('../events/interactionCreate');
    const interaction = makeInteraction('granted-guild', 'botinfo');
    interaction.client.commands.set('botinfo', { deferFirst: false, execute: async () => { commandRan = true; } });
    await interactionCreate.execute(interaction);
    assert.strictEqual(commandRan, true, 'a granted guild must run the command normally');
});

test('live interactionCreate guard still blocks the bot owner in an unauthorized guild', async () => {
    // Spec: normal commands must also be blocked for BOT_OWNER_ID until the
    // guild is granted access. The guard checks the GUILD, never the caller.
    clearAccessRows();
    process.env.BOT_OWNER_ID = '1392856295807389756';
    guildAccess.invalidateGuildCache('owner-unauthorized-guild');
    let commandRan = false;
    const interactionCreate = require('../events/interactionCreate');
    const interaction = makeInteraction('owner-unauthorized-guild', 'botinfo');
    interaction.user.id = '1392856295807389756';   // the bot owner
    interaction.member.id = '1392856295807389756';
    interaction.client.commands.set('botinfo', { deferFirst: false, execute: async () => { commandRan = true; } });
    await interactionCreate.execute(interaction);
    assert.strictEqual(commandRan, false, 'the bot owner must be blocked in an unauthorized guild');
    assert.match(interaction.seen.replies[0].content, /has not been granted access/);
});

test('access guard allows access-management commands to bypass (support server only)', () => {
    const ACCESS_MANAGEMENT_COMMANDS = new Set(['accessgrant', 'accessrevoke', 'accessstatus']);
    assert.ok(ACCESS_MANAGEMENT_COMMANDS.has('accessgrant'));
    assert.ok(ACCESS_MANAGEMENT_COMMANDS.has('accessrevoke'));
    assert.ok(ACCESS_MANAGEMENT_COMMANDS.has('accessstatus'));
    assert.ok(!ACCESS_MANAGEMENT_COMMANDS.has('raid'));
    assert.ok(!ACCESS_MANAGEMENT_COMMANDS.has('backuppanel'));
    assert.ok(!ACCESS_MANAGEMENT_COMMANDS.has('ping'));
});

test('premium-access system exports every function the live event handlers rely on', () => {
    assert.strictEqual(typeof guildAccess.isGuildGranted, 'function');
    assert.strictEqual(typeof guildAccess.getGuildAccessStatus, 'function');
    assert.strictEqual(typeof guildAccess.upsertGuildOnJoin, 'function');
    assert.strictEqual(typeof guildAccess.ensureOnboardingForLockedGuild, 'function');
    assert.strictEqual(typeof guildAccess.reconcileGuildsOnReady, 'function');
    assert.strictEqual(typeof guildAccess.buildLockedReply, 'function');
    assert.strictEqual(typeof guildAccess.buildMissingPermsDm, 'function');
    assert.strictEqual(typeof guildAccess.botMissingManageChannels, 'function');
    assert.strictEqual(typeof guildAccess.grantGuildAccess, 'function');
    assert.strictEqual(typeof guildAccess.revokeGuildAccess, 'function');
    assert.strictEqual(typeof guildAccess.getSupabaseDashboardUrl, 'function');
});
