'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const raidV2 = require('./raidV2');

const DEFAULT_TEST_GUILD_ID = '1536031049774010408';

const TEST_GUILD_ID = (process.env.KAKUZU_TEST_GUILD_ID === undefined)
  ? DEFAULT_TEST_GUILD_ID
  : process.env.KAKUZU_TEST_GUILD_ID;

const data = new SlashCommandBuilder()
  .setName('raidtest')
  .setDescription('Post a fake raid alert (test server only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addStringOption((o) =>
    o.setName('scenario')
      .setDescription('Which fake alert to post')
      .addChoices(
        { name: 'Normal', value: 'normal' },
        { name: 'Full server + waiting list', value: 'full_server_waiting' },
        { name: 'Many helpers (row cap)', value: 'many_helpers' }
      )
  );

function baseRaid() {
  const now = Date.now();
  const min = 60 * 1000;
  return {
    raidId: 1,
    serverIndex: 1,
    createdAt: now - 3 * min,
    status: 'OPEN',
    region: 'ASIA',
    countryCode: 'IN',
    targetGame: 'tsb',
    gameThumbnailUrl: process.env.RAIDTEST_GAME_ICON_URL || null,
    requesterId: '100000000000000001',
    requesterTag: 'TestRequester',
    robloxUsername: 'TestRequester',
    robloxDisplayName: 'Test Requester',
    robloxUserId: null,
    robloxAvatarUrl: process.env.RAIDTEST_AVATAR_URL || 'https://example.com/requester-pfp.png',
    enemyClanNames: 'Test Clan',
    enemyNames: 'EnemyOne, EnemyTwo, EnemyThree, EnemyFour, EnemyFive',
    enemyCount: 5,
    enemyClanPresent: 'NO',
    reason: 'TEST ALERT - fake data',
    helperLimit: 5,
    helpers: [
      { userId: '100000000000000002', robloxDisplayName: 'PlayerOne', joinTime: now - 2 * min, leaveTime: null, timeSpentSeconds: 120 },
      { userId: '100000000000000003', robloxDisplayName: 'PlayerTwo', joinTime: now - 40 * 1000, leaveTime: null, timeSpentSeconds: 40 },
    ],
    inGameHelpers: [],
  };
}

function fakeScenario(name) {
  const now = Date.now();
  const min = 60 * 1000;
  const raid = baseRaid();

  if (name === 'full_server_waiting') {
    raid.helpers = [
      { userId: '100000000000000002', robloxDisplayName: 'PlayerOne', joinTime: now - 2 * min, leaveTime: null, timeSpentSeconds: 120 },
      { userId: '100000000000000003', robloxDisplayName: 'PlayerTwo', joinTime: now - 40 * 1000, leaveTime: null, timeSpentSeconds: 40 },
    ];
    raid.inGameHelpers = ['PlayerFive', 'PlayerSix', 'PlayerSeven', 'PlayerEight', 'PlayerNine'];
    return { raid, skipped: ['server status (playing/max)', 'waiting list'] };
  }

  if (name === 'many_helpers') {
    const helpers = [];
    for (let i = 1; i <= 12; i++) {
      helpers.push({
        userId: '1000000000000000' + String(10 + i),
        robloxDisplayName: 'Player' + i,
        joinTime: now - (13 - i) * min,
        leaveTime: (i % 5 === 0) ? (now - 30 * 1000) : null,
        timeSpentSeconds: (i % 5 === 0) ? 240 : 0,
      });
    }
    raid.helpers = helpers;
    raid.helperLimit = 15;
    raid.inGameHelpers = Array.from({ length: 14 }, (_, i) => 'Online' + (i + 1));
    return { raid, skipped: ['server status (playing/max)', 'waiting list'] };
  }

  raid.inGameHelpers = ['PlayerFive', 'PlayerSix'];
  return { raid, skipped: ['server status (playing/max)', 'waiting list'] };
}

function isAllowedHere(interaction) {
  return Boolean(TEST_GUILD_ID) && interaction.guildId === TEST_GUILD_ID;
}

function disabledButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('raidtest:help').setLabel('Help').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId('raidtest:edit').setLabel('Edit').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('raidtest:close').setLabel('CLOSE RAID').setStyle(ButtonStyle.Secondary).setDisabled(true)
  );
}

async function execute(interaction) {
  if (!isAllowedHere(interaction)) {
    return interaction.reply({
      content: 'This test command is restricted to the Kakuzu Support server.',
      ephemeral: true,
    });
  }
  const perms = interaction.memberPermissions;
  if (!perms || !(perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild))) {
    return interaction.reply({ content: 'You need Manage Server to use this.', flags: MessageFlags.Ephemeral });
  }

  const scenario = interaction.options.getString('scenario') || 'normal';
  const { raid } = fakeScenario(scenario);
  const payload = await raidV2.buildRaidAlertPayload(raid, disabledButtonRow());

  await interaction.reply(Object.assign({}, payload, {
    allowedMentions: { parse: [] },
  }));

  const timer = setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

async function registerRaidTest(client) {
  if (!TEST_GUILD_ID) return;
  try {
    await client.application.commands.create(data.toJSON(), TEST_GUILD_ID);
    console.log('[raidtest] registered in test guild');
  } catch (err) {
    console.warn('[raidtest] registration failed:', err && err.message);
  }
}

module.exports = {
  data,
  execute,
  registerRaidTest,
  fakeScenario,
  isAllowedHere,
  TEST_GUILD_ID,
};
