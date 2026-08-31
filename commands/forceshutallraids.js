const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forceshutallraids')
        .setDescription('Force close all active raids immediately. Admin only.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const guildId = interaction.guild.id;
        const closedCount = raidStateManager.closeAllRaids(guildId);
        // Every closed raid's temporary alert channel self-deletes in 1 min.
        const raidsData = raidStateManager.loadRaids(guildId);
        for (const r of raidsData.raids) {
            raidStateManager.scheduleRaidAlertChannelDeletion(interaction.client, r.raidId, guildId);
        }
        await interaction.reply({ content: `All raids have been force-closed. ${closedCount} raid(s) were shut down. Temporary raid alert channels will be deleted in 1 minute.`, flags: 64 });
    }
};
