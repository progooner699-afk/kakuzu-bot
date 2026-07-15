const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setinfochannel')
        .setDescription('Set the log channel where completed verification profiles are sent.')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('The channel to receive verification submissions')
                .setRequired(true)
        ),
    async execute(interaction) {
        // Server Owner only check
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({
                content: '❌ **Access Denied.** Only the Server Owner can configure verification channels.',
                flags: 64
            });
        }

        const channel = interaction.options.getChannel('channel');
        const settings = raidStateManager.loadSettings();
        settings.infoChannel = channel.id;
        raidStateManager.saveSettings(settings);

        await interaction.reply({
            content: `✅ Verification log channel set to ${channel}. All completed player profiles will be sent there.`,
            flags: 64
        });
    }
};