const test = require('node:test');
const assert = require('assert');
const raidResultCard = require('../handlers/raidResultCard');

function fakeRaid(overrides = {}) {
    return {
        raidId: 42,
        status: 'CLOSED',
        requesterId: '111222333',
        mvpUserId: '222333444',
        targetGame: 'tsb',
        robloxUsername: 'TargetUser',
        region: 'MUMBAI',
        enemyNames: 'enemy_one, enemy_two',
        enemyCount: 2,
        enemyClanNames: 'Lucent',
        reason: 'They called more people',
        helpers: [
            { userId: '222333444', robloxUsername: 'MvpGuy', robloxDisplayName: 'MVP Guy', timeSpentSeconds: 300, avatarUrl: 'https://example.com/mvp.png' },
            { userId: '333444555', robloxUsername: 'OtherGuy', robloxDisplayName: 'Other', timeSpentSeconds: 100 }
        ],
        createdAt: Date.now() - 600000,
        closedAt: Date.now(),
        ...overrides
    };
}

function collectText(container) {
    return container.components
        .flatMap((c) => {
            if (c.type === 9) return (c.components || []).map((x) => x.content || '');
            if (c.type === 10) return [c.content || ''];
            return [];
        })
        .join('\n');
}

test('builds a V2 payload with the IS_COMPONENTS_V2 flag and a Container', () => {
    const payload = raidResultCard.buildResultCardPayload({
        raid: fakeRaid(),
        outcome: 'win',
        submitterId: '999888777'
    });
    assert.strictEqual(payload.flags, 1 << 15); // IS_COMPONENTS_V2
    assert.strictEqual(payload.components.length, 1);
    assert.strictEqual(payload.components[0].type, 17); // Container
});

test('rally picture becomes the TOP banner image; default banner used otherwise', () => {
    const withRally = raidResultCard.buildResultCardPayload({
        raid: fakeRaid(), outcome: 'win', submitterId: '9', rallyPicUrl: 'https://example.com/rally.png'
    });
    const gallery = withRally.components[0].components[0];
    assert.strictEqual(gallery.type, 12); // MediaGallery
    assert.strictEqual(gallery.items[0].media.url, 'https://example.com/rally.png');

    const withoutRally = raidResultCard.buildResultCardPayload({
        raid: fakeRaid(), outcome: 'win', submitterId: '9'
    });
    assert.strictEqual(withoutRally.components[0].components[0].items[0].media.url,
        raidResultCard.DEFAULT_BANNER_IMAGE);
});

test('the 3 outcome types render 3 different titles', () => {
    const titles = {};
    for (const outcome of ['win', 'whooped', 'loss']) {
        const payload = raidResultCard.buildResultCardPayload({
            raid: fakeRaid(), outcome, submitterId: '9'
        });
        const text = collectText(payload.components[0]);
        titles[outcome] = text;
        assert.ok(text.includes('RAID'), 'card should contain the RAID title');
    }
    assert.ok(titles.win.includes('RAID WON'));
    assert.ok(titles.whooped.includes('RAID WHOOPED'));
    assert.ok(titles.loss.includes('RAID LOST'));
    // Every title differs from the others.
    assert.notStrictEqual(titles.win, titles.whooped);
    assert.notStrictEqual(titles.win, titles.loss);
    assert.notStrictEqual(titles.whooped, titles.loss);
});

test('card contains INFO, MVP section with thumbnail, helpers and footer', () => {
    const payload = raidResultCard.buildResultCardPayload({
        raid: fakeRaid(), outcome: 'win', submitterId: '999888777',
        proofUrls: ['https://example.com/proof1.png']
    });
    const container = payload.components[0];
    const text = collectText(container);
    assert.ok(text.includes('INFO'));
    assert.ok(text.includes('Requested By:'));
    assert.ok(text.includes('Ended By:'));
    assert.ok(text.includes('Raid Duration:'));
    assert.ok(text.includes("Ender's Note") || text.includes('Ender\u2019s Note'));
    assert.ok(text.includes('HELPERS'));
    assert.ok(text.includes('Raid Proof:'));
    assert.ok(text.includes('Kakuzu Raid Network'));

    // MVP section is a Section (type 9) with a Thumbnail accessory (type 11).
    const sections = container.components.filter((c) => c.type === 9);
    assert.ok(sections.length >= 1);
    assert.ok(sections.every((s) => s.accessory && s.accessory.type === 11),
        'every Section must carry a thumbnail accessory');
    assert.strictEqual(sections[0].accessory.media.url, 'https://example.com/mvp.png');
});

test('raid proof images are text links, never gallery items', () => {
    const payload = raidResultCard.buildResultCardPayload({
        raid: fakeRaid(), outcome: 'win', submitterId: '9',
        proofUrls: ['https://example.com/proof1.png', 'https://example.com/proof2.png']
    });
    const text = collectText(payload.components[0]);
    assert.ok(text.includes('[Image 1](https://example.com/proof1.png)'));
    assert.ok(text.includes('[Image 2](https://example.com/proof2.png)'));
    // Only ONE MediaGallery in the whole card (the top banner).
    const galleries = payload.components[0].components.filter((c) => c.type === 12);
    assert.strictEqual(galleries.length, 1);
});

test('fallback embed works without a V2 payload', () => {
    const embed = raidResultCard.buildResultFallbackEmbed({
        raid: fakeRaid(), outcome: 'loss', submitterId: '9',
        streakMessage: '**Current Streak:** 3 Matches consecutive!'
    });
    assert.ok(embed.data.title.includes('RAID LOST'));
    assert.ok(embed.data.description.includes('Current Streak'));
    assert.ok(embed.data.fields.some((f) => f.name === 'Deployment Squad Roster'));
});

test('no-result note embed says no results were recorded', () => {
    const embed = raidResultCard.buildNoResultEmbed({ raid: fakeRaid(), closedById: '9' });
    assert.ok(embed.data.title.includes('NO RAID RESULTS RECORDED'));
    assert.ok(embed.data.description.includes('#42'));
});
