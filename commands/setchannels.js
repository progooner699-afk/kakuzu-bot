const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setchannels')
        .setDescription('Configure the raid and help channels, plus optional leaderboard logging.')
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
                .setName('leaderboard_log_channel')
                .setDescription('Leaderboard logs channel')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const raidChannel = interaction.options.getChannel('raid_channel').id;
        const helpChannel = interaction.options.getChannel('help_channel').id;
        const leaderboardLogChannelOption = interaction.options.getChannel('leaderboard_log_channel');
        const leaderboardLogChannel = leaderboardLogChannelOption ? leaderboardLogChannelOption.id : null;

        const settings = raidStateManager.loadSettings();
        settings.raidChannel = raidChannel;
        settings.helpChannel = helpChannel;
        settings.leaderboardLogChannel = leaderboardLogChannel;

        raidStateManager.saveSettings(settings);
        await interaction.reply({
            content: 'Channels configured successfully. Raid alerts, help requests, and leaderboard logging are now enabled.',
            flags: 64
        });
    }
};
