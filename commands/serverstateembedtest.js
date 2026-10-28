'use strict';

const {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags,
} = require('discord.js');

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
        new TextDisplayBuilder().setContent('┃ Live raid participation and server information.')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            '> 📊 **Statistics Labels**\n' +
            '```\n' +
            '👥 TOTAL HELPERS       -|-       🖥️ SERVER STATUS       -|-       🕒 POS\n' +
            '```\n' +
            '> 📈 **Statistics Values**\n' +
            '```\n' +
            '4 / 10                -|-       🟢 FULL                -|-       2\n' +
            '```'
        )
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('🎮 **ALREADY IN GAME**')
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('> PlayerFive, PlayerSix, PlayerSeven, PlayerEight, PlayerNine')
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('📄 **DESCRIPTION**')
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('> ' + String(description || SAMPLE_DESCRIPTION).replace(/\n/g, '\n> '))
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('👥 **HELPER LIST**')
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
    .setDescription('Post a standalone server stats embed (UI test, mock data).');

async function execute(interaction) {
    const payload = buildPayload(SAMPLE_DESCRIPTION, false);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.channel) {
        await interaction.channel.send(Object.assign({}, payload, { allowedMentions: { parse: [] } }));
    }
    await interaction.deleteReply().catch(() => null);
}

module.exports = {
    data,
    execute,
    buildPayload,
    deferFirst: false,
};