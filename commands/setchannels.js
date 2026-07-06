const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setchannels')
        .setDescription('Configure the raid, help, and leaderboard channels.')
        .addChannelOption(option =>
            option
                .setName('raid_channel')
                .setDescription('Raid alert channel')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option
                .setName('help_channel')
                .setDescription('Help request channel')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option
                .setName('leaderboard_channel')
                .setDescription('Leaderboard channel')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const raidChannel = interaction.options.getChannel('raid_channel').id;
        const helpChannel = interaction.options.getChannel('help_channel').id;
        const leaderboardChannel = interaction.options.getChannel('leaderboard_channel').id;

        const settings = raidStateManager.loadSettings();
        settings.raidChannel = raidChannel;
        settings.helpChannel = helpChannel;
        settings.leaderboardChannel = leaderboardChannel;
        settings.lbChannel = leaderboardChannel;

        raidStateManager.saveSettings(settings);
        await interaction.reply({
            content: 'Channels configured successfully. Raid alerts, help requests, and leaderboard updates are now enabled.',
            flags: 64
        });

        await raidStateManager.publishLeaderboard(interaction.client);
    }
};
