const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('requestraid')
        .setDescription('Request raid backup - shows raid request button.'),
    async execute(interaction) {
        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('request_raid')
                .setLabel('Request Raid')
                .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
            content: [
                'RAID HELP PROTOCOL & RULES',
                '',
                'Please read these guidelines carefully before requesting backup.',
                '',
                'Click the button below to open the raid application form. The bot will auto-detect your game, region, and server link from your Roblox presence.'
            ].join('\n'),
            components: [buttonRow]
        });
    }
};
