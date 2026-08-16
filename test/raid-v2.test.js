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
    region: 'MUMBAI',
    reason: 'Test raid alert',
    helperLimit: 3,
    helpers: [{ userId: '444555666', robloxDisplayName: 'Helper', timeSpentSeconds: 75 }],
    createdAt: Date.now() - 120000,
    ...overrides
  };
}

test('sets the native V2 flag and wraps in a Container with accent color', () => {
  const payload = raidV2.buildRaidAlertPayload(fakeRaid());
  assert.strictEqual(payload.flags, 1 << 15); // IS_COMPONENTS_V2
  assert.strictEqual(payload.components.length, 1);
  const container = payload.components[0];
  assert.strictEqual(container.type, 17); // Container
  assert.strictEqual(container.accent_color, 0xff0000);
  assert.ok(container.components.length >= 8);
});

test('sections are boxes wrapping text displays', () => {
  const payload = raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const sections = container.components.filter((c) => c.type === 9);
  assert.ok(sections.length >= 5);
  sections.forEach((s) => {
    assert.ok(s.components.length >= 1);
    assert.ok(s.components.every((c) => c.type === 10)); // Text Displays
  });
});

test('native separators sit between every section with divider true', () => {
  const payload = raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const separators = container.components.filter((c) => c.type === 14);
  assert.ok(separators.length >= 4);
  separators.forEach((s) => {
    assert.strictEqual(s.divider, true);
    assert.strictEqual(s.spacing, 1);
  });
});

test('all alert sections are represented in text displays', () => {
  const payload = raidV2.buildRaidAlertPayload(fakeRaid());
  const container = payload.components[0];
  const contents = container.components
    .filter((c) => c.type === 9)
    .flatMap((s) => s.components)
    .map((c) => c.content)
    .join(String.fromCharCode(10));
  assert.ok(contents.includes('RAID ALERT #7'));
  assert.ok(contents.includes('DETAILS'));
  assert.ok(contents.includes('IN-GAME HELPERS'));
  assert.ok(contents.includes('LIVE HELPERS'));
});

test('button row is attached inside the container', () => {
  const row = { toJSON: () => ({ type: 1, components: [{ type: 2, label: 'X' }] }) };
  const payload = raidV2.buildRaidAlertPayload(fakeRaid(), row);
  const container = payload.components[0];
  const rows = container.components.filter((c) => c.type === 1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].components.length, 1);
});