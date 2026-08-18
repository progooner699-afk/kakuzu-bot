const test = require('node:test');
const assert = require('assert');
const raidV2 = require('../handlers/raidV2');

function fakeRaid(overrides = {}) {
  return {
    raidId: 7,
    status: 'OPEN',
    requesterId: '111222333',
    targetGame: 'tsb',
    robloxUsername: 'TestUser',
    robloxUserId: null, // no live Roblox API calls in unit tests
    robloxAvatarUrl: 'https://example.com/requester-pfp.png',
    region: 'MUMBAI',
    reason: 'Test raid alert',
    helperLimit: 3,
    helpers: [{ userId: '444555666', robloxDisplayName: 'Helper', timeSpentSeconds: 75 }],
    createdAt: Date.now() - 120000,
    ...overrides
  };
}

test('sets the native V2 flag and wraps in a Container with accent color', async () => {
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid());
  assert.strictEqual(payload.flags, 1 << 15); // IS_COMPONENTS_V2
  assert.strictEqual(payload.components.length, 1);
  const container = payload.components[0];
  assert.strictEqual(container.type, 17); // Container
  assert.strictEqual(container.accent_color, 0xed4245);
  assert.ok(container.components.length >= 8);
});

test('only header and details are Sections, each with a thumbnail accessory', async () => {
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const sections = container.components.filter((c) => c.type === 9);
  const textDisplays = container.components.filter((c) => c.type === 10);
  // Discord rejects any Section (type 9) that has no accessory, so only the two
  // thumbnail-bearing blocks (header pfp + DETAILS) may be Sections.
  assert.strictEqual(sections.length, 2);
  assert.ok(sections.every((s) => s.accessory && s.accessory.type === 11)); // Thumbnail
  // IN-GAME HELPERS / DESCRIPTION / LIVE HELPERS have no image -> TextDisplay.
  const allText = textDisplays.flatMap((c) => c.content).join(String.fromCharCode(10));
  assert.ok(allText.includes('IN-GAME HELPERS'));
  assert.ok(allText.includes('DESCRIPTION'));
  assert.ok(allText.includes('LIVE HELPERS'));
});

test('native separators sit between every section with divider true', async () => {
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const separators = container.components.filter((c) => c.type === 14);
  assert.ok(separators.length >= 4);
  separators.forEach((s) => {
    assert.strictEqual(s.divider, true);
    assert.strictEqual(s.spacing, 1);
  });
});

test('all alert sections are represented in text displays', async () => {
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const contents = container.components
    .flatMap((c) => {
      if (c.type === 9) return (c.components || []).map((x) => x.content || '');
      if (c.type === 10) return [c.content || ''];
      return [];
    })
    .join(String.fromCharCode(10));
  assert.ok(contents.includes('RAID ALERT #7'));
  assert.ok(contents.includes('DETAILS'));
  assert.ok(contents.includes('IN-GAME HELPERS'));
  assert.ok(contents.includes('LIVE HELPERS'));
});

test('button row is attached inside the container', async () => {
  const row = { toJSON: () => ({ type: 1, components: [{ type: 2, label: 'X' }] }) };
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid(), row);
  const container = payload.components[0];
  const rows = container.components.filter((c) => c.type === 1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].components.length, 1);
});

test('every section/title is followed by a native separator, including before buttons', async () => {
  const row = { toJSON: () => ({ type: 1, components: [{ type: 2, label: 'X' }] }) };
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid(), row);
  const components = payload.components[0].components;

  // Each section (type 9) must be immediately followed by a Separator (type 14).
  for (let i = 0; i < components.length - 1; i++) {
    if (components[i].type === 9) {
      assert.strictEqual(components[i + 1].type, 14);
    }
  }

  // The buttons row must be preceded by a separator (never a bare section).
  const btnIdx = components.findIndex((c) => c.type === 1);
  assert.ok(btnIdx > 0, 'buttons row should not be the first component');
  assert.strictEqual(components[btnIdx - 1].type, 14);
});

test('alert with no helpers still has a separator after every section', async () => {
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid({ helpers: [] }));
  const components = payload.components[0].components;
  for (let i = 0; i < components.length - 1; i++) {
    if (components[i].type === 9) {
      assert.strictEqual(components[i + 1].type, 14);
    }
  }
});

test('requester pfp thumbnail on the header section, game thumbnail on DETAILS', async () => {
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const sections = container.components.filter((c) => c.type === 9);
  const header = sections[0];   // title/status section -> requester pfp
  const details = sections[1];  // DETAILS section -> static game thumbnail
  assert.strictEqual(header.accessory.type, 11); // Thumbnail
  assert.match(header.accessory.media.url, /^https:\/\//);
  assert.strictEqual(details.accessory.type, 11);
  assert.match(details.accessory.media.url, /^https:\/\//);
  // The two thumbnails must be different (requester pfp vs game thumbnail)
  assert.notStrictEqual(header.accessory.media.url, details.accessory.media.url);
});

test('field rows in DETAILS / IN-GAME HELPERS / LIVE HELPERS are quote-barred', async () => {
  const payload = await raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const contents = container.components
    .flatMap((c) => {
      if (c.type === 9) return (c.components || []).map((x) => x.content || '');
      if (c.type === 10) return [c.content || ''];
      return [];
    })
    .join(String.fromCharCode(10));
  assert.ok(contents.includes('> **Game:**'));
  assert.ok(contents.includes('> **Raid ID:**'));
  assert.ok(contents.includes('> **Total Helpers Joined:**'));
  assert.ok(contents.includes('> • <@444555666>'));
});

test('header with no requester avatar is a TextDisplay (no accessory-less Section)', async () => {
  // No avatar -> the header must fall back to a type-10 TextDisplay instead of a
  // Section (type 9) without an accessory, which Discord rejects.
  const payload = await raidV2.buildRaidAlertPayload(
    fakeRaid({ robloxUserId: null, requesterId: null, robloxAvatarUrl: null })
  );
  const container = payload.components[0];
  const sections = container.components.filter((c) => c.type === 9);
  assert.ok(sections.every((s) => s.accessory && s.accessory.type === 11),
    'every Section must carry a thumbnail accessory');
  const textContents = container.components
    .filter((c) => c.type === 10)
    .flatMap((c) => c.content)
    .join('\n');
  assert.ok(textContents.includes('RAID ALERT #7'));
});
