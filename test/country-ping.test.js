const test = require('node:test');
const assert = require('assert');
const rsm = require('../handlers/raidStateManager');

function fakeRaid(overrides = {}) {
  return {
    raidId: 9,
    status: 'OPEN',
    requesterId: '111222333',
    targetGame: 'tsb',
    robloxUsername: 'TestUser',
    region: 'ASIA',
    countryCode: '',
    reason: 'Test',
    helperLimit: 3,
    helpers: [],
    createdAt: Date.now(),
    ...overrides
  };
}

test('countryCodeToName maps codes to human-readable names', () => {
  assert.strictEqual(rsm.countryCodeToName('IN'), 'India');
  assert.strictEqual(rsm.countryCodeToName('SG'), 'Singapore');
  assert.strictEqual(rsm.countryCodeToName('DE'), 'Germany');
  assert.strictEqual(rsm.countryCodeToName('US'), 'United States');
  assert.strictEqual(rsm.countryCodeToName('in'), 'India');      // case-insensitive
  assert.strictEqual(rsm.countryCodeToName('  de  '), 'Germany'); // trimmed
  assert.strictEqual(rsm.countryCodeToName(null), 'Unknown');     // missing
  assert.strictEqual(rsm.countryCodeToName(''), 'Unknown');       // empty
});

test('formatRaidMessage shows Region then Country, full country name', () => {
  const embeds = rsm.formatRaidMessage(fakeRaid({ region: 'ASIA', countryCode: 'IN' }), 'guild1');
  const detailsField = embeds[0].data.fields.find((f) => f.name.includes('DETAILS'));
  assert.ok(detailsField.value.includes('**Region:** `ASIA`'));
  assert.ok(detailsField.value.includes('**Country:** `India`'));
  // Region must come before Country
  assert.ok(detailsField.value.indexOf('Region') < detailsField.value.indexOf('Country'));
});

test('formatRaidMessage shows Unknown country when not detected', () => {
  const embeds = rsm.formatRaidMessage(fakeRaid({ region: 'ASIA' }), 'guild1');
  const detailsField = embeds[0].data.fields.find((f) => f.name.includes('DETAILS'));
  assert.ok(detailsField.value.includes('**Region:** `ASIA`'));
  assert.ok(detailsField.value.includes('**Country:** `Unknown`'));
});

test('formatRaidMessage keeps region + shows country for DE/EU', () => {
  const embeds = rsm.formatRaidMessage(fakeRaid({ region: 'EU', countryCode: 'DE' }), 'guild1');
  const detailsField = embeds[0].data.fields.find((f) => f.name.includes('DETAILS'));
  assert.ok(detailsField.value.includes('**Region:** `EU`'));
  assert.ok(detailsField.value.includes('**Country:** `Germany`'));
});

test('formatRaidMessage removes Target and adds ENEMY NAMES field before DETAILS', () => {
  const raid = fakeRaid({
    region: 'ASIA', countryCode: 'IN',
    enemyClanNames: 'Some Clan',
    enemyNames: 'P1, P2, P3'
  });
  const fields = rsm.formatRaidMessage(raid, 'guild1')[0].data.fields;

  // ENEMY NAMES field exists, is the first field (before DETAILS), and shows a code box.
  const enemyField = fields[0];
  assert.ok(enemyField.name.includes('ENEMY NAMES'));
  assert.ok(enemyField.value.includes('```'));
  assert.ok(enemyField.value.includes('Enemy Clan: Some Clan'));
  assert.ok(enemyField.value.includes('Enemies: P1, P2, P3'));
  assert.ok(fields.findIndex((f) => f.name.includes('DETAILS')) > fields.findIndex((f) => f.name.includes('ENEMY NAMES')));

  // Target must have been removed from the DETAILS block.
  const detailsField = fields.find((f) => f.name.includes('DETAILS'));
  assert.ok(!detailsField.value.includes('**Target:**'));
});

test('ENEMY NAMES handles missing clan/names gracefully', () => {
  const fields = rsm.formatRaidMessage(fakeRaid({ enemyClanNames: null, enemyNames: '' }), 'guild1')[0].data.fields;
  const enemyField = fields[0];
  assert.ok(enemyField.value.includes('Enemy Clan: Unknown'));
  assert.ok(enemyField.value.includes('Enemies: None'));
});

