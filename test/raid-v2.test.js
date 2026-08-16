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

test('buildRaidAlertPayload sets the native V2 flag and uses only V2 components', () => {
  const payload = raidV2.buildRaidAlertPayload(fakeRaid());
  assert.strictEqual(payload.flags, 1 << 15); // IS_COMPONENTS_V2
  assert.ok(payload.components.length >= 8);
  const nonV2 = payload.components.filter((c) => c.type !== 14 && c.type !== 10);
  assert.deepStrictEqual(nonV2, []);
});

test('native separators carry divider true', () => {
  const payload = raidV2.buildRaidAlertPayload(fakeRaid());
  const separators = payload.components.filter((c) => c.type === 14);
  assert.ok(separators.length >= 4);
  separators.forEach((s) => assert.strictEqual(s.divider, true));
});

test('all alert sections are represented as text displays', () => {
  const payload = raidV2.buildRaidAlertPayload(fakeRaid());
  const contents = payload.components
    .filter((c) => c.type === 10)
    .map((c) => c.content)
    .join('\n');
  assert.ok(contents.includes('RAID ALERT #7'));
  assert.ok(contents.includes('DETAILS'));
  assert.ok(contents.includes('IN-GAME HELPERS'));
  assert.ok(contents.includes('LIVE HELPERS'));
});

test('button row is appended flat, not nested', () => {
  const row = { toJSON: () => ({ type: 1, components: [{ type: 2, label: 'X' }] }) };
  const payload = raidV2.buildRaidAlertPayload(fakeRaid(), row);
  const last = payload.components[payload.components.length - 1];
  assert.strictEqual(last.type, 1);
  assert.strictEqual(last.components.length, 1);
});