const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forceshutallraids')
        .setDescription('Force close all active raids immediately. Admin only.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const closedCount = raidStateManager.closeAllRaids();
        await interaction.reply({ content: `All raids have been force-closed. ${closedCount} raid(s) were shut down.`, flags: 64 });
    }
};
