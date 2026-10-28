'use strict';

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

const raidTest = require('../handlers/raidTest');

const V2_FLAGS = 1 << 15;

const SAMPLE_DESCRIPTION = 'Enemy clan at spawn, need 5 helpers.';

const HELPERS = [
    { name: 'PlayerOne', emoji: '🟢', status: 'IN GAME', time: '2m' },
    { name: 'PlayerTwo', emoji: '🟢', status: 'IN GAME', time: '40s' },
    { name: 'PlayerThree', emoji: '🟡', status: 'POS #1', time: '1m 20s' },
    { name: 'PlayerFour', emoji: '🟡', status: 'POS #2', time: '45s' },
];

function buildPayload(description, closed) {
    const container = new ContainerBuilder().setAccentColor(0x2F3136);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# 📊 SERVER & HELPER STATS')
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('┃ Track helper capacity, server status, and player positions to help raid members coordinate assistance and understand live server activity at a glance.')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            '```\\n' +
            '👥 TOTAL HELPERS         🖥️ SERVER STATUS        🕒 POS\\n' +
            '    4 / 10                 🟢 FULL                    2\\n' +
            '```'
        )
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### 🎮 ALREADY IN GAME')
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('> PlayerFive, PlayerSix, PlayerSeven, PlayerEight, PlayerNine')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### 📄 DESCRIPTION')
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('> ' + String(description || SAMPLE_DESCRIPTION).replace(/\n/g, '\n> '))
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### 👥 HELPER LIST')
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            HELPERS.map((h) =>
                '> • `' + h.name + '` `' + h.emoji + ' ' + h.status + '` ⏱️ ' + h.time
            ).join('\n')
        )
    );

    const containerJson = container.toJSON();
    containerJson.size = 'large';
    return { flags: V2_FLAGS, components: [containerJson] };
}

const data = new SlashCommandBuilder()
    .setName('serverstateembedtest')
    .setDescription('Post a combined raid test and server stats embed (UI test, mock data).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((o) =>
        o.setName('scenario')
            .setDescription('Which fake raid alert to post')
            .addChoices(
                { name: 'Normal', value: 'normal' },
                { name: 'Full server + waiting list', value: 'full_server_waiting' },
                { name: 'Many helpers (row cap)', value: 'many_helpers' }
            )
    );

async function execute(interaction) {
    if (!raidTest.isAllowedHere(interaction)) {
        return interaction.reply({
            content: 'This test command is restricted to the Kakuzu Support server.',
            ephemeral: true,
        });
    }
    const perms = interaction.memberPermissions;
    if (!perms || !(perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild))) {
        return interaction.reply({ content: 'You need Manage Server to use this.', flags: MessageFlags.Ephemeral });
    }

    const scenario = (interaction.options && typeof interaction.options.getString === 'function')
        ? (interaction.options.getString('scenario') || 'normal')
        : 'normal';

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const raidPayload = await raidTest.buildRaidTestPayload(scenario);
    const statsPayload = buildPayload(SAMPLE_DESCRIPTION, false);

    if (interaction.channel) {
        await interaction.channel.send(Object.assign({}, raidPayload, { allowedMentions: { parse: [] } }));
        await interaction.channel.send(Object.assign({}, statsPayload, { allowedMentions: { parse: [] } }));
    }

    await interaction.deleteReply().catch(() => null);
}

module.exports = {
    data,
    execute,
    buildPayload,
    deferFirst: false,
};
