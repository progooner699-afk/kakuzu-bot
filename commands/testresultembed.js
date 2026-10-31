'use strict';

const {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');

const V2_FLAGS = 1 << 15;

const DEFAULT_TEST_GUILD_ID = '1536031049774010408';
const TEST_GUILD_ID = (process.env.KAKUZU_TEST_GUILD_ID === undefined)
    ? DEFAULT_TEST_GUILD_ID
    : process.env.KAKUZU_TEST_GUILD_ID;

function isAllowedHere(interaction) {
    return Boolean(TEST_GUILD_ID) && interaction.guildId === TEST_GUILD_ID;
}

const data = new SlashCommandBuilder()
    .setName('testresultembed')
    .setDescription('Post a fake raid result embed (V2, test server only).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

function buildPayload() {
    const container = new ContainerBuilder().setAccentColor(0x2B2D31);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# RAID RESULT = WON')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## INFO')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    const codeBlock =
        '┌─────────────────────────────────────┐\n' +
        '│  REGION                             │\n' +
        '│  ASIA  INDIA                        │\n' +
        '├─────────────────────────────────────┤\n' +
        '│  ENEMY CLAN                         │\n' +
        '│  Test Clan                          │\n' +
        '├─────────────────────────────────────┤\n' +
        '│  ALLIE CLAN                         │\n' +
        '│  Kakuzu Clan                        │\n' +
        '└─────────────────────────────────────┘\n' +
        'RQ CLAN';

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('```' + '\n' + codeBlock + '\n' + '```')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    const bulletLines = [
        '• **ENEMY NAMES:** EnemyOne, EnemyTwo, EnemyThree, EnemyFour, EnemyFive',
        '• **ALLIE S:** AllyOne, AllyTwo, AllyThree',
        '• **REQUESTED BY:** TestRequester',
        '• **ENDED BY:** TestEnder',
        '• **TIME STARTED:** 10:00 AM',
        '• **ENDED:** 10:15 AM',
        '• **DURATION:** 15m',
        '┃ **ENDER\'S NOTE:** Great raid, everyone performed well.',
    ].join('\n');

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(bulletLines)
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## RAID PROOF')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• [Image 1](https://example.com/proof1.png)\n• [Image 2](https://example.com/proof2.png)')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## HELPERS')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• HelperOne — 15m\n• HelperTwo — 12m\n• HelperThree — 8m')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('┃ Congratulations to everyone who participated in this raid! Your teamwork, coordination, and dedication secured a great victory against the enemy clan. Keep up the excellent work and continue making your clan proud!')
    );

    const containerJson = container.toJSON();
    containerJson.size = 'large';
    return { flags: V2_FLAGS, components: [containerJson] };
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const payload = buildPayload();

    if (interaction.channel) {
        await interaction.channel.send(Object.assign({}, payload, { allowedMentions: { parse: [] } }));
    }

    await interaction.deleteReply().catch(() => null);
}

module.exports = {
    data,
    execute,
    buildPayload,
    isAllowedHere,
    TEST_GUILD_ID,
    deferFirst: false,
};