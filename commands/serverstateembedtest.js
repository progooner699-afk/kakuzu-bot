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

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('serverstateembedtest_help')
            .setLabel('🛟 Help')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!!closed),
        new ButtonBuilder()
            .setCustomId('serverstateembedtest_edit')
            .setLabel('✏️ Edit')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!!closed),
        new ButtonBuilder()
            .setCustomId('serverstateembedtest_close')
            .setLabel('✖️ Close Raid')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!!closed)
    );

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

    return { flags: V2_FLAGS, components: [container, row] };
}

const data = new SlashCommandBuilder()
    .setName('serverstateembedtest')
    .setDescription('Post a standalone server stats embed (UI test, mock data).');

async function execute(interaction) {
    const payload = buildPayload(SAMPLE_DESCRIPTION, false);
    await interaction.reply(Object.assign({}, payload, { allowedMentions: { parse: [] } }));
}

async function handleComponent(interaction) {
    const customId = String(interaction.customId || '');
    if (!customId.startsWith('serverstateembedtest_')) return false;

    if (customId === 'serverstateembedtest_help') {
        await interaction.reply({ content: '🛟 Test help clicked.', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (customId === 'serverstateembedtest_edit') {
        const modal = new ModalBuilder()
            .setCustomId('serverstateembedtest_editmodal_' + interaction.message.id)
            .setTitle('Edit Test Description');
        const input = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Description')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setValue(SAMPLE_DESCRIPTION);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
    }

    if (customId === 'serverstateembedtest_close') {
        try {
            const closedPayload = buildPayload(SAMPLE_DESCRIPTION, true);
            await interaction.update(Object.assign({}, closedPayload, { allowedMentions: { parse: [] } }));
        } catch (e) {
            await interaction.reply({ content: 'Test closed.', flags: MessageFlags.Ephemeral }).catch(() => null);
        }
        return true;
    }

    if (customId.startsWith('serverstateembedtest_editmodal_')) {
        const newDesc = interaction.fields.getTextInputValue('description');
        const payload = buildPayload(newDesc || SAMPLE_DESCRIPTION, false);
        if (interaction.message) {
            await interaction.message.edit(Object.assign({}, payload, { allowedMentions: { parse: [] } })).catch(() => null);
        }
        await interaction.reply({ content: '✅ Description updated.', flags: MessageFlags.Ephemeral });
        return true;
    }

    return false;
}

module.exports = {
    data,
    execute,
    handleComponent,
    buildPayload,
};