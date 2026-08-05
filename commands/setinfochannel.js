const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setinfochannel')
        .setDescription('Set the VERIFICATION LOGS channel (pending verifications for mod review with buttons).')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('The channel where pending verifications appear with Accept/Deny buttons for moderators')
                .setRequired(true)
        ),
    async execute(interaction) {
        // Server Owner only check
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({
                content: '❌ **Access Denied.** Only the Server Owner can configure verification log channels.',
                flags: 64
            });
        }

        const channel = interaction.options.getChannel('channel');
        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        settings.infoChannel = channel.id;
        raidStateManager.saveSettings(guildId, settings);

        await interaction.reply({
            content: `✅ Verification logs channel set to ${channel}. Pending verifications with Accept/Deny buttons will be sent there for moderator review.`,
            flags: 64
        });
    }
};