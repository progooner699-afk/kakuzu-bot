'use strict';

/*
 * raid-result-embed-attachment.test.js — pins the image-delivery change on the
 * classic raid RESULT embed (win / whooped / loss all share this send path):
 *
 *  1. The rally/proof screenshot is attached directly (files: [attachment]) as
 *     a STANDALONE image next to the embed — the embed itself carries NO
 *     .setImage(), so its container expands to FULL WIDTH.
 *  2. Image + embed go out in ONE single channel.send() payload — never two
 *     messages — so they collapse under a single bot header.
 *  3. Everything else on the embed (fields, text, color, timestamp, footer)
 *     is byte-identical to the untouched raidResultCard output.
 *
 * Plus the degradation contract: any failed download (HTTP error, non-image,
 * oversized, thrown fetch) yields null → the embed still sends, hotlinked as a
 * markdown link, in exactly one message.
 */

const test = require('node:test');
const assert = require('node:assert');
const { AttachmentBuilder } = require('discord.js');

const raidResultCard = require('../handlers/raidResultCard');
const interactionCreate = require('../events/interactionCreate');

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4]);

function fakeRaid(overrides = {}) {
    return Object.assign({
        raidId: 5,
        serverIndex: 1,
        status: 'CLOSED',
        outcome: 'whooped',
        requesterId: '111222333',
        requesterTag: 'tester',
        targetGame: 'tsb',
        region: 'ASIA',
        countryCode: 'IN',
        enemyCount: 2,
        enemyNames: 'a, b',
        enemyClanNames: 'clanX',
        reason: 'test reason',
        helperLimit: 4,
        createdAt: 1787291439516,
        closedAt: 1787291526706,
        closedBy: '444555666',
        closeReason: 'gg wp',
        helpers: [{ userId: '555', robloxUsername: 'h1', timeSpentSeconds: 600 }],
        mvpUserId: '555'
    }, overrides);
}

function makeCardOpts(overrides = {}) {
    return Object.assign({
        raid: fakeRaid(),
        outcome: 'whooped',
        submitterId: '444555666',
        rallyPicUrl: 'https://cdn.example/rally.png',
        proofUrls: ['https://cdn.example/proof1.png'],
        streakMessage: '**Current Streak:** 💀 2 Matches consecutive!',
        endedAtMs: 1787291526706
    }, overrides);
}

/** Minimal fetch stub returning a well-formed image Response. */
function fakeFetch({ ok = true, contentType = 'image/png', body = FAKE_PNG, contentLength } = {}) {
    return async () => ({
        ok,
        headers: {
            get(name) {
                if (name === 'content-type') return contentType;
                if (name === 'content-length') return String(contentLength != null ? contentLength : body.length);
                return null;
            }
        },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    });
}

function makeChannel() {
    const sends = [];
    return { sends, send: async (payload) => { sends.push(payload); return { id: 'm1' }; } };
}

const REGION = { mention: '<@&999>', allowedMentions: { roles: ['999'] } };

test('proof image + embed go out in ONE payload; the embed has NO image so it stays full width', async () => {
    const channel = makeChannel();
    await interactionCreate.sendFallbackResultEmbed({
        channel,
        cardOpts: makeCardOpts(),
        proofSourceUrl: 'https://cdn.example/rally.png',
        regionRoleInfo: REGION,
        fetchImpl: fakeFetch()
    });

    assert.strictEqual(channel.sends.length, 1, 'must be a SINGLE channel.send — never two messages');
    const payload = channel.sends[0];
    assert.strictEqual(payload.embeds.length, 1, 'exactly one embed in the payload');
    assert.strictEqual(payload.embeds[0].data.image, undefined,
        'the embed must carry NO image, otherwise its container shrinks to the image width');
    assert.ok(Array.isArray(payload.files) && payload.files.length === 1, 'files must carry the proof attachment');
    assert.ok(payload.files[0] instanceof AttachmentBuilder);
    assert.strictEqual(payload.files[0].name, 'raid-proof.png', 'attachment name identifies the standalone file');
    assert.deepStrictEqual(Buffer.from(payload.files[0].attachment), FAKE_PNG, 'the downloaded bytes ride along');
    assert.strictEqual(payload.content, REGION.mention, 'the region ping stays in the SAME message');
});

test('everything except the image reference is byte-identical to the untouched builder output', async () => {
    const channel = makeChannel();
    const cardOpts = makeCardOpts();
    await interactionCreate.sendFallbackResultEmbed({
        channel,
        cardOpts,
        proofSourceUrl: 'https://cdn.example/rally.png',
        regionRoleInfo: REGION,
        fetchImpl: fakeFetch()
    });

    const control = raidResultCard.buildResultFallbackEmbed(cardOpts).toJSON();
    const sent = channel.sends[0].embeds[0].toJSON();
    // The builder itself no longer sets an image (full-width embed), so the
    // sent embed must match the control EXACTLY — no image added anywhere.
    assert.deepStrictEqual(sent, control, 'fields, text, color, timestamp and footer must not change');
    assert.strictEqual(sent.image, undefined, 'no image may be present on the sent embed');
});

test('no proof source -> single message, no files, image-free embed', async () => {
    const channel = makeChannel();
    await interactionCreate.sendFallbackResultEmbed({
        channel,
        cardOpts: makeCardOpts(),
        proofSourceUrl: null,
        regionRoleInfo: REGION,
        fetchImpl: fakeFetch() // must never be called
    });
    assert.strictEqual(channel.sends.length, 1);
    const payload = channel.sends[0];
    assert.deepStrictEqual(payload.files, []);
    assert.strictEqual(payload.embeds[0].data.image, undefined, 'no proof -> no image, exactly like before');
});

test('degraded downloads keep the screenshot as a LINK — still ONE message, embed never dropped', async () => {
    const scenarios = [
        { label: 'HTTP error', opts: { ok: false } },
        { label: 'non-image body', opts: { contentType: 'text/html' } },
        { label: 'oversized declared length', opts: { contentLength: 9 * 1024 * 1024 } }
    ];
    for (const scenario of scenarios) {
        const channel = makeChannel();
        await interactionCreate.sendFallbackResultEmbed({
            channel,
            cardOpts: makeCardOpts(),
            proofSourceUrl: 'https://cdn.example/rally.png',
            regionRoleInfo: REGION,
            fetchImpl: fakeFetch(scenario.opts)
        });
        assert.strictEqual(channel.sends.length, 1, scenario.label + ': exactly one send');
        const payload = channel.sends[0];
        assert.deepStrictEqual(payload.files, [], scenario.label + ': no file attached');
        assert.strictEqual(payload.embeds[0].data.image, undefined,
            scenario.label + ': the embed must stay image-free (full width)');
        assert.ok(payload.embeds[0].data.fields.some(f => f.value.includes('https://cdn.example/rally.png')),
            scenario.label + ': keeps the rally screenshot reachable as a link');
    }

    // A thrown fetch (timeout / network) must behave the same way.
    const channel = makeChannel();
    await interactionCreate.sendFallbackResultEmbed({
        channel,
        cardOpts: makeCardOpts(),
        proofSourceUrl: 'https://cdn.example/rally.png',
        regionRoleInfo: REGION,
        fetchImpl: async () => { throw new Error('fetch timed out after 10000ms'); }
    });
    assert.strictEqual(channel.sends.length, 1, 'thrown fetch: still exactly one send');
    assert.deepStrictEqual(channel.sends[0].files, []);
    assert.strictEqual(channel.sends[0].embeds[0].data.image, undefined);
    assert.ok(channel.sends[0].embeds[0].data.fields.some(f => f.value.includes('https://cdn.example/rally.png')),
        'thrown fetch: the rally screenshot stays reachable as a link');
});

test('buildRaidProofAttachment: success and failure contracts', async () => {
    const okAttachment = await interactionCreate.buildRaidProofAttachment('https://cdn.example/p.png', fakeFetch());
    assert.ok(okAttachment instanceof AttachmentBuilder);
    assert.strictEqual(okAttachment.name, 'raid-proof.png');

    assert.strictEqual(await interactionCreate.buildRaidProofAttachment('', fakeFetch()), null, 'empty url');
    assert.strictEqual(await interactionCreate.buildRaidProofAttachment('https://x/p', fakeFetch({ ok: false })), null, 'HTTP error');
    assert.strictEqual(await interactionCreate.buildRaidProofAttachment('https://x/p', fakeFetch({ contentType: 'application/json' })), null, 'non-image');
    assert.strictEqual(await interactionCreate.buildRaidProofAttachment('https://x/p', fakeFetch({ contentLength: 20 * 1024 * 1024 })), null, 'oversized (declared)');
    assert.strictEqual(await interactionCreate.buildRaidProofAttachment('https://x/p', async () => { throw new Error('boom'); }), null, 'thrown fetch');
    assert.strictEqual(await interactionCreate.buildRaidProofAttachment(null, fakeFetch()), null, 'null url');
});

