const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unsetchannels')
        .setDescription('Reset all configured channels (raid, help, leaderboard, result, info) to none.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const settings = raidStateManager.loadSettings();
        settings.raidChannel = null;
        settings.helpChannel = null;
        settings.leaderboardChannel = null;
        settings.lbChannel = null;
        settings.leaderboardMessageId = null;
        settings.resultChannel = null;
        settings.infoChannel = null;
        raidStateManager.saveSettings(settings);

        await interaction.reply({
            content: '✅ **All channels have been unset successfully.**\n\n' +
                     'The following channels have been reset:\n' +
                     '• Raid Alert Channel\n' +
                     '• Help Channel\n' +
                     '• Leaderboard Channel\n' +
                     '• Result Channel\n' +
                     '• Player Info Channel\n\n' +
                     'Use `/setchannels` and `/setinfochannel` to reconfigure them.',
            flags: 64
        });
    }
};