const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setverificationresultchannel')
        .setDescription('Set the channel where final Accepted/Rejected verification embeds are posted.')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('The channel for final verification result embeds')
                .setRequired(true)
        ),
    async execute(interaction) {
        // Server Owner only check
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({
                content: '❌ **Access Denied.** Only the Server Owner can configure verification result channels.',
                flags: 64
            });
        }

        const channel = interaction.options.getChannel('channel');
        const settings = raidStateManager.loadSettings();
        settings.verificationResultChannel = channel.id;
        raidStateManager.saveSettings(settings);

        await interaction.reply({
            content: `✅ Verification result channel set to ${channel}. Final accepted/rejected embeds will be sent there.`,
            flags: 64
        });
    }
};