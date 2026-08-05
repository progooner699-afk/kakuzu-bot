const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unsetchannels')
        .setDescription('Reset all configured channels (raid, result, info) to none.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        settings.raidChannel = null;
        settings.resultChannel = null;
        settings.infoChannel = null;
        raidStateManager.saveSettings(guildId, settings);

        await interaction.reply({
            content: '✅ **All channels have been unset successfully.**\n\n' +
                     'The following channels have been reset:\n' +
                     '• Raid Alert Channel\n' +
                     '• Result Channel\n' +
                     '• Player Info Channel\n\n' +
                     'Use `/setchannels` and `/setinfochannel` to reconfigure them.',
            flags: 64
        });
    }
};