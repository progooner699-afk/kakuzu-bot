const test = require('node:test');
const assert = require('assert');
const raidTest = require('../handlers/raidTest');
const raidV2 = require('../handlers/raidV2');

test('raidtest command data has correct name and scenarios', () => {
  const json = raidTest.data.toJSON();
  assert.strictEqual(json.name, 'raidtest');
  const opt = json.options.find((o) => o.name === 'scenario');
  assert.ok(opt);
  const values = opt.choices.map((c) => c.value);
  assert.deepStrictEqual(values, ['normal', 'full_server_waiting', 'many_helpers']);
});

test('isAllowedHere refuses non-test guilds', () => {
  const interaction = { guildId: '999999999999999999' };
  assert.strictEqual(raidTest.isAllowedHere(interaction), false);
});

test('isAllowedHere allows test guild', () => {
  const interaction = { guildId: raidTest.TEST_GUILD_ID };
  assert.strictEqual(raidTest.isAllowedHere(interaction), true);
});

test('fakeScenario normal produces a payload', async () => {
  const { raid } = raidTest.fakeScenario('normal');
  const payload = await raidV2.buildRaidAlertPayload(raid, null);
  assert.strictEqual(payload.flags, 1 << 15);
  assert.ok(payload.components.length === 1);
});

test('fakeScenario full_server_waiting produces a payload', async () => {
  const { raid } = raidTest.fakeScenario('full_server_waiting');
  const payload = await raidV2.buildRaidAlertPayload(raid, null);
  assert.ok(payload.components.length === 1);
});

test('fakeScenario many_helpers produces a payload', async () => {
  const { raid } = raidTest.fakeScenario('many_helpers');
  const payload = await raidV2.buildRaidAlertPayload(raid, null);
  assert.ok(payload.components.length === 1);
});

test('execute refuses non-test guild', async () => {
  const interaction = {
    guildId: '111111111111111111',
    memberPermissions: { has: () => true },
    options: { getString: () => 'normal' },
    reply: async (p) => { interaction._reply = p; },
  };
  await raidTest.execute(interaction);
  assert.ok(interaction._reply.content.includes('restricted to the Kakuzu Support server'));
});

test('execute refuses non-admin', async () => {
  const interaction = {
    guildId: raidTest.TEST_GUILD_ID,
    memberPermissions: { has: () => false },
    options: { getString: () => 'normal' },
    reply: async (p) => { interaction._reply = p; },
  };
  await raidTest.execute(interaction);
  assert.ok(interaction._reply.content.includes('Manage Server'));
});

test('execute sends dual-embed mock layout on success', async () => {
  const interaction = {
    guildId: raidTest.TEST_GUILD_ID,
    memberPermissions: { has: () => true },
    options: { getString: () => 'normal' },
    reply: async (p) => { interaction._reply = p; },
  };
  await raidTest.execute(interaction);
  assert.strictEqual(interaction._reply.embeds.length, 2);
  assert.strictEqual(interaction._reply.components.length, 1);
  assert.strictEqual(interaction._reply.embeds[0].data.color, 0x2f3136);
  assert.strictEqual(interaction._reply.embeds[1].data.color, 0x2ecc71);
});
