const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setchannels')
        .setDescription('Configure operational channels for raid alerts, help requests, and combat results.')
        .addChannelOption(option =>
            option
                .setName('raid_channel')
                .setDescription('The channel where active raid alerts are posted')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option
                .setName('help_channel')
                .setDescription('The channel for handling raid help requests')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option
                .setName('result_channel')
                .setDescription('The channel where final raid outcomes, wins, losses, and streaks are logged')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const raidChannel = interaction.options.getChannel('raid_channel').id;
        const helpChannel = interaction.options.getChannel('help_channel').id;
        const resultChannel = interaction.options.getChannel('result_channel').id;

        const settings = raidStateManager.loadSettings();
        settings.raidChannel = raidChannel;
        settings.helpChannel = helpChannel;
        settings.resultChannel = resultChannel;

        // Cleans out the legacy log channel parameter from settings.json automatically
        if (settings.leaderboardLogChannel) {
            delete settings.leaderboardLogChannel;
        }

        raidStateManager.saveSettings(settings);
        
        await interaction.reply({
            content: '✅ **System Channels Configured Successfully!** Active alerts, help queues, and your win/loss combat log are now bound.',
            flags: 64
        });
    }
};
