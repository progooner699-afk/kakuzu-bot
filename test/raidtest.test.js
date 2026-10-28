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

test('execute sends V2 raid alert on success', async () => {
  const interaction = {
    guildId: raidTest.TEST_GUILD_ID,
    memberPermissions: { has: () => true },
    options: { getString: () => 'normal' },
    reply: async (p) => { interaction._reply = p; },
    deleteReply: async () => {},
  };
  await raidTest.execute(interaction);
  assert.strictEqual(interaction._reply.flags, 1 << 15);
  assert.strictEqual(interaction._reply.components.length, 1);
});

function containerOf(payload) {
  return payload.components[0];
}

function allText(payload) {
  const c = containerOf(payload);
  const out = [];
  for (const comp of c.components || []) {
    if (comp.content) out.push(comp.content);
    if (Array.isArray(comp.components)) {
      for (const inner of comp.components) {
        if (inner.content) out.push(inner.content);
      }
    }
  }
  return out.join('\n');
}

test('test alert omits helper sections and keeps core sections', async () => {
  const { raid } = raidTest.fakeScenario('normal');
  const row = new (require('discord.js').ActionRowBuilder)();
  const payload = await raidV2.buildRaidAlertPayload(raid, null, { omitHelperSections: true });
  const text = allText(payload);
  assert.ok(!/IN-GAME HELPERS/.test(text));
  assert.ok(!/LIVE HELPERS/.test(text));
  assert.ok(/ENEMY NAMES/.test(text));
  assert.ok(/DETAILS/.test(text));
  assert.ok(/DESCRIPTION/.test(text));
});

test('test alert component layout has no bad separators', async () => {
  const interaction = {
    guildId: raidTest.TEST_GUILD_ID,
    memberPermissions: { has: () => true },
    options: { getString: () => 'normal' },
    reply: async (p) => { interaction._reply = p; },
    deleteReply: async () => {},
  };
  await raidTest.execute(interaction);
  const c = interaction._reply.components[0];
  const types = c.components.map((x) => x.type);
  assert.notStrictEqual(types[0], 14);
  assert.notStrictEqual(types[types.length - 1], 14);
  for (let i = 0; i < types.length - 1; i++) {
    assert.ok(!(types[i] === 14 && types[i + 1] === 14), 'double separator at ' + i);
  }
  // three buttons present
  const buttons = c.components.flatMap((x) => (x.components ? x.components : [])).filter((x) => x.type === 2);
  assert.strictEqual(buttons.length, 3);
});

test('real alert payload keeps both helper sections', async () => {
  const { raid } = raidTest.fakeScenario('normal');
  const payload = await raidV2.buildRaidAlertPayload(raid, null);
  const text = allText(payload);
  assert.ok(/IN-GAME HELPERS/.test(text));
  assert.ok(/LIVE HELPERS/.test(text));
});

