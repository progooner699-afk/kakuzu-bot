'use strict';

/*
 * raid-admin-roles.test.js — STRICT PER-GUILD raid admin authorization.
 * Covers isRaidAdmin (fast-path / role match / fail-closed / stale grace /
 * CROSS-GUILD ISOLATION), saveRaidAdminRoles (upsert keyed by guild_id, cache
 * only on success), guardRaidAction + the exact denial message, canCloseRaid
 * rendering, and the /adminsetup component re-check. Supabase is faked by
 * patching handlers/supabaseDb methods (raidAdminRoles calls through the
 * module object), so tests are hermetic and never touch a real database.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Collection } = require('discord.js');

const supabaseDb = require('../handlers/supabaseDb');
const raidAdminRoles = require('../handlers/raidAdminRoles');
const interactionCreate = require('../events/interactionCreate');
const adminSetupCmd = require('../commands/adminsetup');

const GUILD_A = 'guild-A';
const GUILD_B = 'guild-B';
const STAFF_ROLE = 'role-staff-111';

/** Minimal GuildMember stand-in bound to a specific guild. */
function makeMember({ id = 'user-1', guildId = GUILD_B, admin = false, roleIds = [] } = {}) {
    const cache = new Collection();
    for (const roleId of roleIds) cache.set(roleId, { id: roleId });
    return {
        id,
        guild: { id: guildId },
        permissions: { has: () => admin === true },
        roles: { cache }
    };
}

/** Patches supabaseDb for one test; restores in t.after(). */
function patchDb(t, { isConfigured = () => true, queryOne, runQuery } = {}) {
    const original = {
        isConfigured: supabaseDb.isConfigured,
        queryOne: supabaseDb.queryOne,
        runQuery: supabaseDb.runQuery
    };
    supabaseDb.isConfigured = isConfigured;
    if (queryOne) supabaseDb.queryOne = queryOne;
    if (runQuery) supabaseDb.runQuery = runQuery;
    t.after(() => { Object.assign(supabaseDb, original); });
}

/** Minimal button-interaction stand-in capturing replies. */
function makeInteraction({ userId = 'intruder', member, guildId = GUILD_B } = {}) {
    const seen = { replies: [] };
    return {
        seen,
        user: { id: userId },
        member,
        guildId,
        guild: { id: guildId },
        reply: async (payload) => { seen.replies.push(payload); return {}; }
    };
}

test.beforeEach(() => raidAdminRoles._resetCacheForTests());

/* ======================= isRaidAdmin ======================= */

test('isRaidAdmin: Discord Administrator in the same guild passes with NO database read', async (t) => {
    patchDb(t, { queryOne: async () => { throw new Error('queryOne must not run on the admin fast-path'); } });
    const member = makeMember({ guildId: GUILD_B, admin: true });
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(member, GUILD_B), true);
});

test('isRaidAdmin: an /adminsetup-assigned role of THIS guild passes; unassigned members fail', async (t) => {
    patchDb(t, {
        queryOne: async (sql, params) => {
            assert.ok(sql.includes('guild_configs'), 'read must target guild_configs');
            return params[0] === GUILD_B ? { raid_admin_roles: [STAFF_ROLE] } : { raid_admin_roles: [] };
        }
    });
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(makeMember({ guildId: GUILD_B, roleIds: [STAFF_ROLE] }), GUILD_B), true);
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(makeMember({ guildId: GUILD_B, roleIds: ['random-role'] }), GUILD_B), false);
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(makeMember({ guildId: GUILD_B }), GUILD_B), false);
});

test('STRICT ISOLATION: a staff role configured in guild A grants NOTHING in guild B', async (t) => {
    patchDb(t, {
        queryOne: async (sql, params) => (params[0] === GUILD_A ? { raid_admin_roles: [STAFF_ROLE] } : { raid_admin_roles: [] })
    });
    const staffInA = makeMember({ id: 'same-user', guildId: GUILD_A, roleIds: [STAFF_ROLE] });
    const sameUserInB = makeMember({ id: 'same-user', guildId: GUILD_B, roleIds: [STAFF_ROLE] });
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(staffInA, GUILD_A), true);
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(sameUserInB, GUILD_B), false,
        'staff status in guild A must never leak into guild B');
});

test('STRICT ISOLATION: a member object from another guild is rejected before any check', async (t) => {
    let dbTouched = false;
    patchDb(t, { queryOne: async () => { dbTouched = true; return { raid_admin_roles: [STAFF_ROLE] }; } });
    const adminOfA = makeMember({ guildId: GUILD_A, admin: true, roleIds: [STAFF_ROLE] });
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(adminOfA, GUILD_B), false);
    assert.strictEqual(dbTouched, false, 'no database read may happen for a mismatched member');
});

test('fail-closed: a database failure with no cached roles means NOT admin', async (t) => {
    patchDb(t, { queryOne: async () => { throw new Error('boom'); } });
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(makeMember({ guildId: GUILD_B, roleIds: [STAFF_ROLE] }), GUILD_B), false);
});

test('outage resilience: recent confirmed cache authorizes within the stale grace, then fails closed', async (t) => {
    patchDb(t, { queryOne: async () => { throw new Error('boom'); } });
    raidAdminRoles._seedCacheForTests(GUILD_B, [STAFF_ROLE], 2 * 60 * 1000); // 2min old — inside 5min grace
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(makeMember({ guildId: GUILD_B, roleIds: [STAFF_ROLE] }), GUILD_B), true);
    raidAdminRoles._seedCacheForTests(GUILD_B, [STAFF_ROLE], 6 * 60 * 1000); // 6min old — past grace
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(makeMember({ guildId: GUILD_B, roleIds: [STAFF_ROLE] }), GUILD_B), false);
});

/* ======================= saveRaidAdminRoles ======================= */

test('saveRaidAdminRoles: UPSERT keyed by guild_id; cache refreshed only on success', async (t) => {
    const calls = [];
    let queryMode = 'must-use-cache';
    patchDb(t, {
        runQuery: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
        queryOne: async () => {
            if (queryMode === 'must-use-cache') throw new Error('fresh cache must answer without a DB read');
            return { raid_admin_roles: [] };
        }
    });
    const saved = await raidAdminRoles.saveRaidAdminRoles(GUILD_B, [STAFF_ROLE, STAFF_ROLE, ' ', null]);
    assert.deepStrictEqual(saved, [STAFF_ROLE], 'input must be normalized (deduped, trimmed, junk dropped)');
    const upsert = calls.find(c => c.sql.includes('INSERT INTO guild_configs'));
    assert.ok(upsert, 'an INSERT into guild_configs must run');
    assert.ok(upsert.sql.includes('ON CONFLICT (guild_id)'), 'upsert must key on guild_id');
    assert.deepStrictEqual(upsert.params, [GUILD_B, [STAFF_ROLE]]);
    assert.deepStrictEqual(raidAdminRoles.getCachedRaidAdminRoles(GUILD_B), [STAFF_ROLE]);
    queryMode = 'ok';
    assert.strictEqual(await raidAdminRoles.isRaidAdmin(makeMember({ guildId: GUILD_B, roleIds: [STAFF_ROLE] }), GUILD_B), true,
        'the saved cache must authorize without another DB read');
});

test('saveRaidAdminRoles: a failed write rethrows (sanitized) and never poisons the cache', async (t) => {
    raidAdminRoles._seedCacheForTests(GUILD_B, ['old-role'], 0);
    patchDb(t, {
        runQuery: async (sql) => {
            if (sql.includes('CREATE TABLE')) return { rows: [] };
            throw new Error('insert failed');
        }
    });
    await assert.rejects(() => raidAdminRoles.saveRaidAdminRoles(GUILD_B, [STAFF_ROLE]), /Could not save raid admin roles/);
    assert.deepStrictEqual(raidAdminRoles.getCachedRaidAdminRoles(GUILD_B), ['old-role'],
        'a failed save must keep the previous confirmed roles');
});

/* ======================= guardRaidAction / denial message ======================= */

test('buildRaidAccessDeniedMessage: exact denial text', () => {
    assert.strictEqual(
        raidAdminRoles.buildRaidAccessDeniedMessage({ raidId: 1, requesterId: '424242' }),
        '❌ **Access Denied:** Only the original Raid Requester (<@424242>) or a designated Admin in this server can edit or end this raid.'
    );
});

test('guardRaidAction: the requester always passes without any database read', async (t) => {
    patchDb(t, { queryOne: async () => { throw new Error('must not be called for the requester'); } });
    const raid = { raidId: 1, requesterId: 'requester-1' };
    const interaction = makeInteraction({ userId: 'requester-1', member: makeMember({ guildId: GUILD_B }) });
    assert.strictEqual(await interactionCreate.guardRaidAction(interaction, raid), true);
    assert.strictEqual(interaction.seen.replies.length, 0);
});

test('guardRaidAction: an assigned raid admin of THIS guild passes', async (t) => {
    raidAdminRoles._seedCacheForTests(GUILD_B, [STAFF_ROLE], 0);
    patchDb(t, { queryOne: async () => { throw new Error('fresh cache must answer without a DB read'); } });
    const interaction = makeInteraction({ userId: 'helper-1', member: makeMember({ guildId: GUILD_B, roleIds: [STAFF_ROLE] }) });
    assert.strictEqual(await interactionCreate.guardRaidAction(interaction, { raidId: 1, requesterId: 'requester-1' }), true);
    assert.strictEqual(interaction.seen.replies.length, 0);
});

test('guardRaidAction: everyone else gets the exact ephemeral denial', async (t) => {
    patchDb(t, { queryOne: async () => ({ raid_admin_roles: [] }) });
    const raid = { raidId: 1, requesterId: 'requester-1' };
    const interaction = makeInteraction({ userId: 'intruder', member: makeMember({ guildId: GUILD_B }) });
    assert.strictEqual(await interactionCreate.guardRaidAction(interaction, raid), false);
    assert.strictEqual(interaction.seen.replies.length, 1);
    assert.strictEqual(interaction.seen.replies[0].content, raidAdminRoles.buildRaidAccessDeniedMessage(raid));
    assert.strictEqual(interaction.seen.replies[0].flags, 64, 'the denial must be ephemeral');
});

test('guardRaidAction: staff of ANOTHER guild is denied in this one', async (t) => {
    patchDb(t, {
        queryOne: async (sql, params) => (params[0] === GUILD_A ? { raid_admin_roles: [STAFF_ROLE] } : { raid_admin_roles: [] })
    });
    const staffOfA = makeMember({ id: 'staff-user', guildId: GUILD_A, roleIds: [STAFF_ROLE] });
    const interaction = makeInteraction({ userId: 'staff-user', member: staffOfA, guildId: GUILD_B });
    assert.strictEqual(await interactionCreate.guardRaidAction(interaction, { raidId: 1, requesterId: 'requester-1' }), false);
    assert.strictEqual(interaction.seen.replies.length, 1);
    assert.strictEqual(interaction.seen.replies[0].flags, 64);
});

test('canCloseRaid (button rendering): requester / Administrator / cached per-guild roles only', (t) => {
    raidAdminRoles._seedCacheForTests(GUILD_B, [STAFF_ROLE], 0);
    patchDb(t, {});
    const raid = { raidId: 1, requesterId: 'requester-1' };
    assert.strictEqual(interactionCreate.canCloseRaid(makeMember({ id: 'requester-1', guildId: GUILD_B }), raid), true);
    assert.strictEqual(interactionCreate.canCloseRaid(makeMember({ guildId: GUILD_B, admin: true }), raid), true);
    assert.strictEqual(interactionCreate.canCloseRaid(makeMember({ guildId: GUILD_B, roleIds: [STAFF_ROLE] }), raid), true);
    assert.strictEqual(interactionCreate.canCloseRaid(makeMember({ guildId: GUILD_B }), raid), false);
    // Same role id, but in ANOTHER guild -> no visibility there either.
    assert.strictEqual(interactionCreate.canCloseRaid(makeMember({ guildId: GUILD_A, roleIds: [STAFF_ROLE] }), raid), false);
});

/* ======================= /adminsetup component handler ======================= */

/** Minimal component-interaction stand-in for the /adminsetup panel. */
function makePanelInteraction({ member, values = [], customId = adminSetupCmd.ROLE_SELECT_ID, guildId = GUILD_B } = {}) {
    const seen = { acks: [], edits: [], follows: [], replies: [] };
    const guildRoles = new Collection();
    guildRoles.set(STAFF_ROLE, { id: STAFF_ROLE, name: 'Raid Staff' });
    return {
        seen,
        customId,
        guildId,
        user: { id: 'admin-1' },
        member,
        guild: { id: guildId, name: 'Guild ' + guildId, roles: { cache: guildRoles } },
        values,
        deferred: false,
        replied: false,
        deferUpdate: async () => { seen.acks.push('deferUpdate'); },
        editReply: async (p) => { seen.edits.push(p); return {}; },
        followUp: async (p) => { seen.follows.push(p); return {}; },
        reply: async (p) => { seen.replies.push(p); return {}; }
    };
}

test('/adminsetup: a NON-administrator can never change roles — denied, nothing written', async (t) => {
    let wrote = false;
    patchDb(t, { runQuery: async () => { wrote = true; return { rows: [] }; } });
    const interaction = makePanelInteraction({
        member: makeMember({ guildId: GUILD_B, admin: false }),
        values: [STAFF_ROLE]
    });
    assert.strictEqual(await adminSetupCmd.handleAdminSetupComponent(interaction), true);
    assert.deepStrictEqual(interaction.seen.acks, ['deferUpdate'], 'the component must be acknowledged first');
    assert.ok(interaction.seen.follows.some(p => p.content.includes('Access Denied')), 'an access-denied follow-up must be sent');
    assert.strictEqual(wrote, false, 'no database write may happen for a non-admin');
});

test('/adminsetup: an administrator selection is sanitized and UPSERTed for THIS guild only', async (t) => {
    const calls = [];
    patchDb(t, { runQuery: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
    const interaction = makePanelInteraction({
        member: makeMember({ guildId: GUILD_B, admin: true }),
        values: [STAFF_ROLE, GUILD_B, 'ghost-role'] // @everyone + deleted role must be dropped
    });
    assert.strictEqual(await adminSetupCmd.handleAdminSetupComponent(interaction), true);
    const upsert = calls.find(c => c.sql.includes('INSERT INTO guild_configs'));
    assert.ok(upsert, 'the select must persist through the guild_configs upsert');
    assert.deepStrictEqual(upsert.params, [GUILD_B, [STAFF_ROLE]],
        'strictly keyed by the interaction guild; @everyone and ghost roles dropped');
    const panel = interaction.seen.edits[0];
    assert.ok(panel && panel.embeds && panel.embeds[0], 'the panel must be re-rendered');
    assert.ok(panel.embeds[0].data.description.includes('<@&' + STAFF_ROLE + '>'), 'the saved role must be listed on the panel');
});

test('/adminsetup: foreign customIds are not handled by the builder', async (t) => {
    patchDb(t, {});
    const interaction = makePanelInteraction({
        member: makeMember({ guildId: GUILD_B, admin: true }),
        customId: 'pingsetup_abc_rolesel'
    });
    assert.strictEqual(await adminSetupCmd.handleAdminSetupComponent(interaction), false);
});


