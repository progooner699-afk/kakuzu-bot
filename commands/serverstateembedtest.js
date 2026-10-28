'use strict';

const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
} = require('discord.js');

const V2_FLAGS = 1 << 15;

const SAMPLE_DESCRIPTION = 'Enemy clan at spawn, need 5 helpers.';

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
            '```\n' +
            '👥 TOTAL HELPERS      🖥️ SERVER STATUS      🕒 WAITING\n' +
            '4 / 10               🟢 FULL               2\n' +
            '```'
        )
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('👥 **HELPER LIST**')
    );
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            '```\n' +
            '1. PlayerOne  [ IN SERVER ]   2m\n' +
            '2. PlayerTwo  [ IN SERVER ]   40s\n' +
            '3. PlayerThree [ WAITING #1 ] 1m 20s\n' +
            '4. PlayerFour [ WAITING #2 ] 45s\n' +
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

    const row = null;
    return { flags: V2_FLAGS, components: [container] };
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