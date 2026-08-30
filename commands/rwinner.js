'use strict';

const {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');

// Native Components V2 flag (IS_COMPONENTS_V2) — required for Separator
// components and disables content/embeds, so everything renders as components.
const RWINNER_V2_FLAGS = 1 << 15;

// Accent color bar (gold — winner/results).
const RESULTS_ACCENT_COLOR = 0xD4AF37;

// Builds the "Results" Components V2 payload: title + 4 named fields
// (1 / 2 / 3 / 4) separated by native Separator components.
function buildResultsPayload() {
    const text = function (content) {
        return new TextDisplayBuilder().setContent(content).toJSON(); // type 10
    };
    const separator = function () {
        return new SeparatorBuilder() // type 14
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small)
            .toJSON();
    };

    const container = new ContainerBuilder().setAccentColor(RESULTS_ACCENT_COLOR).toJSON();
    container.size = 'large';

    const contents = [];

    // Title
    contents.push(text('# 🏆 Results'));
    contents.push(separator());

    // Four fields, named 1 2 3 4, each followed by a separator.
    for (let i = 1; i <= 4; i++) {
        contents.push(text('**' + i + '**' + '\n> -'));
        if (i < 4) contents.push(separator());
    }

    container.components = contents;

    return {
        flags: RWINNER_V2_FLAGS,
        components: [container]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rwinner')
        .setDescription('Post the raid results embed (4 fields with separators).'),
    buildResultsPayload,
    async execute(interaction) {
        const payload = buildResultsPayload();
        await interaction.channel.send(payload).catch(err => console.error('rwinner: failed to post results embed:', err));
        await interaction.reply({ content: '✅ Results embed posted.', flags: 64 }).catch(() => null);
    }
};
