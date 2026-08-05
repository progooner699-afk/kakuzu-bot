const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setlockedpingrole')
        .setDescription('Set the role assigned to new members to lock them until verification.')
        .addRoleOption(option =>
            option
                .setName('role')
                .setDescription('The role to assign (restricts access to waiting/verification channels)')
                .setRequired(true)
        ),
    async execute(interaction) {
        // Server Owner only check
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({
                content: '❌ **Access Denied.** Only the Server Owner can configure the locked ping role.',
                flags: 64
            });
        }

        const role = interaction.options.getRole('role');
        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        settings.lockedPingRoleId = role.id;
        raidStateManager.saveSettings(guildId, settings);

        await interaction.reply({
            content: `✅ Locked ping role set to ${role}. New members will automatically receive this role upon joining.`,
            flags: 64
        });
    }
};