'use strict';

/*
 * testing-embed-2.test.js — /testing-embed-2 (support-server-only raid
 * result dump inside a ```text code block).
 *
 * Verifies:
 *  - REGISTRATION FILTERING: the command is included ONLY for guild
 *    1536031049774010408 (Kakuzu Support), excluded for any other guild and
 *    excluded entirely from a no-guildId (global-capable) payload.
 *  - RENDERING: raid data (placeId, jobId, region/country, timestamps,
 *    duration, requester, helpers, MVP) is emitted line-by-line inside ONE
 *    ```text fence, using the SAME formatters as the raid result card.
 *  - SAFETY: backticks in data never break the fence; the content is
 *    hard-capped at Discord's 2000-character limit; `guild_id` is
 *    digits-only validated before touching the raid store.
 *
 * raidStateManager.getRaidById is patched per test (property lookup at call
 * time), so no real raid files are read or written.
 */

const test = require('node:test');
const assert = require('node:assert');

const commandHandler = require('../handlers/commandHandler');
const raidStateManager = require('../handlers/raidStateManager');
const testingEmbed2 = require('../commands/testingEmbed2');

const SUPPORT_GUILD_ID = '1536031049774010408';

/** Closed-win raid fixture covering every dumped field. */
function makeRaid(overrides = {}) {
    return Object.assign({
        raidId: 7,
        serverIndex: 2,
        status: 'CLOSED',
        outcome: 'win',
        requesterId: '111222333',
        requesterTag: 'tester',
        targetGame: 'tsb',
        robloxUsername: 'tester',
        robloxDisplayName: 'Tester',
        placeId: '10449761463',
        serverId: '5285a311-b28c-43b7-903c-285f04b11a48',
        serverLink: 'https://www.roblox.com/games/10449761463',
        region: 'ASIA',
        countryCode: 'IN',
        enemyCount: 3,
        enemyNames: 'a, b, c',
        enemyClanNames: 'clanX',
        reason: 'test reason',
        helperLimit: 5,
        createdAt: 1787291439516,
        closedAt: 1787291526706,
        closedBy: '444555666',
        closedByTag: 'closer',
        closeReason: 'gg `wp`',
        helpers: [
            { userId: '555', robloxUsername: 'h1', timeSpentSeconds: 860 },
            { userId: '666', robloxUsername: 'h2', timeSpentSeconds: 120 }
        ],
        mvpUserId: '555',
        channelId: '1540236025308127263',
        messageId: '1540236025308127264'
    }, overrides);
}

function makeInteraction({ raidId = 7, guildIdOption = null, guildId = SUPPORT_GUILD_ID } = {}) {
    const seen = { replies: [] };
    return {
        seen,
        guildId,
        options: {
            getInteger: (name) => (name === 'raid_id' ? raidId : null),
            getString: (name) => (name === 'guild_id' ? guildIdOption : null)
        },
        editReply: async (payload) => { seen.replies.push(payload); return {}; }
    };
}

test('registration: name, allowlist export, and per-guild payload filtering', () => {
    assert.strictEqual(testingEmbed2.data.name, 'testing-embed-2');
    assert.deepStrictEqual(testingEmbed2.guildIds, [SUPPORT_GUILD_ID]);

    const support = commandHandler.getCommandDataArray(SUPPORT_GUILD_ID).map(c => c.name);
    assert.ok(support.includes('testing-embed-2'), 'must be included for the support guild');

    const other = commandHandler.getCommandDataArray('999999999999999999').map(c => c.name);
    assert.ok(!other.includes('testing-embed-2'), 'must NOT be included for any other guild');

    const globalPayload = commandHandler.getCommandDataArray().map(c => c.name);
    assert.ok(!globalPayload.includes('testing-embed-2'), 'must NEVER reach a no-guildId (global-capable) payload');

    // Sanity: unrestricted commands are unaffected by the filter.
    assert.ok(support.includes('botinfo') && other.includes('botinfo') && globalPayload.includes('botinfo'));
});

test('execute renders the raid data inside ONE ```text block, line by line', async () => {
    const original = raidStateManager.getRaidById;
    const calls = [];
    raidStateManager.getRaidById = (raidId, guildId) => { calls.push({ raidId, guildId }); return makeRaid(); };
    try {
        const interaction = makeInteraction();
        await testingEmbed2.execute(interaction);

        const content = interaction.seen.replies[0].content;
        assert.ok(content.startsWith('```text\n[RAID RESULT DATA]\n'), 'must open with the header inside a text fence');
        assert.ok(content.endsWith('\n```'), 'must close the code block');
        assert.ok(content.includes('Place ID: 10449761463'));
        assert.ok(content.includes('Job ID: 5285a311-b28c-43b7-903c-285f04b11a48'));
        assert.ok(content.includes('Region: ASIA'));
        assert.ok(content.includes('Country: India (IN)'));
        assert.ok(content.includes('Requester: <@111222333>'));
        assert.ok(content.includes('Requested At: '));
        // Duration uses the SAME formatTimeSpent logic as the result card.
        assert.ok(content.includes('Duration: ' + raidStateManager.formatTimeSpent(87)));
        assert.ok(content.includes('Outcome: win -> WIN'));
        assert.ok(content.includes('Helpers Joined: 2'));
        assert.ok(content.includes('[MVP] <@555>'), 'the MVP helper line must be marked');
        assert.ok(!content.includes('gg `wp`'), 'backticks in data must be sanitized so they cannot break the fence');
        assert.deepStrictEqual(calls, [{ raidId: 7, guildId: SUPPORT_GUILD_ID }], 'defaults to the invoking guild');
    } finally {
        raidStateManager.getRaidById = original;
    }
});

test('execute searches the provided source guild and defaults to the invoking guild', async () => {
    const original = raidStateManager.getRaidById;
    const calls = [];
    raidStateManager.getRaidById = (raidId, guildId) => { calls.push({ raidId, guildId }); return makeRaid(); };
    try {
        const explicit = makeInteraction({ raidId: 3, guildIdOption: '1534458060041486346' });
        await testingEmbed2.execute(explicit);
        assert.deepStrictEqual(calls[0], { raidId: 3, guildId: '1534458060041486346' });

        const defaulted = makeInteraction({ raidId: 4, guildIdOption: null, guildId: '777888999' });
        await testingEmbed2.execute(defaulted);
        assert.deepStrictEqual(calls[1], { raidId: 4, guildId: '777888999' });
    } finally {
        raidStateManager.getRaidById = original;
    }
});

test('execute rejects a non-numeric guild_id BEFORE touching the raid store', async () => {
    const original = raidStateManager.getRaidById;
    let touched = false;
    raidStateManager.getRaidById = () => { touched = true; return makeRaid(); };
    try {
        const interaction = makeInteraction({ guildIdOption: '../../etc' });
        await testingEmbed2.execute(interaction);
        assert.strictEqual(touched, false, 'path-shaped input must never reach the raid store');
        assert.ok(interaction.seen.replies[0].content.includes('numeric'), 'a validation error must be shown');
    } finally {
        raidStateManager.getRaidById = original;
    }
});

test('execute replies with a clear error when the raid does not exist', async () => {
    const original = raidStateManager.getRaidById;
    raidStateManager.getRaidById = () => null;
    try {
        const interaction = makeInteraction({ raidId: 999 });
        await testingEmbed2.execute(interaction);
        assert.ok(interaction.seen.replies[0].content.includes('not found'));
        assert.ok(interaction.seen.replies[0].content.includes('999'));
    } finally {
        raidStateManager.getRaidById = original;
    }
});

test('large helper rosters are truncated so the message ALWAYS fits Discord\'s 2000-char limit', async () => {
    const original = raidStateManager.getRaidById;
    const manyHelpers = Array.from({ length: 60 }, (_, i) => ({
        userId: 'u' + i,
        robloxUsername: 'verylongrobloxusername_' + i,
        timeSpentSeconds: 3600 + i
    }));
    raidStateManager.getRaidById = () => makeRaid({ helpers: manyHelpers, mvpUserId: 'u0' });
    try {
        const interaction = makeInteraction();
        await testingEmbed2.execute(interaction);
        const content = interaction.seen.replies[0].content;
        assert.ok(content.length <= 2000, 'content must stay within the 2000-char cap (got ' + content.length + ')');
        assert.ok(content.startsWith('```text\n[RAID RESULT DATA]\n'));
        assert.ok(content.endsWith('\n```'), 'the fence must still close after truncation');
        assert.ok(content.includes('more helpers omitted'), 'omission must be explicit, not silent');
    } finally {
        raidStateManager.getRaidById = original;
    }
});

test('buildCodeBlock: fits pathological line sets by dropping data lines with an explicit note', () => {
    const huge = Array.from({ length: 100 }, (_, i) => 'Line ' + i + ': ' + 'x'.repeat(120));
    const block = testingEmbed2.buildCodeBlock(huge, ['helper']);
    assert.ok(block.length <= 2000, 'hard cap must hold (got ' + block.length + ')');
    assert.ok(block.startsWith('```text\n'));
    assert.ok(block.endsWith('\n```'));
    assert.ok(block.includes('more data lines omitted'));
});

