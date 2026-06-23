const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('raidcounts')
        .setDescription('Set the raid counts leaderboard channel and publish the current raid count message.')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('The channel where raid count leaderboard updates should be posted')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const channel = interaction.options.getChannel('channel');
        if (!channel || !channel.isTextBased()) {
            return interaction.reply({ content: 'Please select a valid text channel for raid count updates.', flags: 64 });
        }

        const settings = raidStateManager.loadSettings();
        settings.lbChannel = channel.id;
        raidStateManager.saveSettings(settings);

        try {
            await raidStateManager.publishLeaderboard(interaction.client);
            return interaction.reply({ content: `Raid counts leaderboard channel has been set to ${channel}. A fresh raid count message has been published there.`, flags: 64 });
        } catch (error) {
            console.error('Failed to publish raid counts leaderboard message:', error);
            return interaction.reply({ content: 'Raid count channel was updated, but publishing the leaderboard message failed. Check the bot permissions in the selected channel.', flags: 64 });
        }
    }
};
