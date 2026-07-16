const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setchannels')
        .setDescription('Configure the raid alert and raid result channels.')
        .addChannelOption(option =>
            option
                .setName('raid_channel')
                .setDescription('Raid alert channel')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option
                .setName('result_channel')
                .setDescription('Channel where raid result embeds will be posted')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const raidChannel = interaction.options.getChannel('raid_channel').id;
        const resultChannel = interaction.options.getChannel('result_channel').id;

        const settings = raidStateManager.loadSettings();
        settings.raidChannel = raidChannel;
        settings.resultChannel = resultChannel;

        raidStateManager.saveSettings(settings);
        await interaction.reply({
            content: 'Channels configured successfully. Raid alerts will be posted in <#' + raidChannel + '> and raid result embeds will be sent to <#' + resultChannel + '>.',
            flags: 64
        });
    }
};