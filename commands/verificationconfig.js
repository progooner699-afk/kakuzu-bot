const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('verificationconfig')
        .setDescription("Show this server's verification configuration."),
    async execute(interaction) {
        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        const adminRoles = Array.isArray(settings.verificationAdminRoles) ? settings.verificationAdminRoles : [];

        const hasLogs = !!settings.verificationLogsChannel;
        const hasResult = !!settings.verificationResultChannel;
        const complete = hasLogs && hasResult;

        const embed = new EmbedBuilder()
            .setTitle('Verification Configuration')
            .setColor(complete ? 0x2ECC71 : 0xE74C3C)
            .setThumbnail(interaction.guild.iconURL({ size: 256 }) || interaction.client.user.displayAvatarURL({ size: 256 }))
            .addFields([
                { name: 'Verification Logs', value: settings.verificationLogsChannel ? `<#${settings.verificationLogsChannel}>` : 'Not set', inline: true },
                { name: 'Verification Results', value: settings.verificationResultChannel ? `<#${settings.verificationResultChannel}>` : 'Not set', inline: true },
                { name: 'Verification Admin Roles', value: adminRoles.length ? adminRoles.map(id => `<@&${id}>`).join(' ') : 'None (only Administrators)', inline: false },
                { name: 'Status', value: complete ? '✅ Configuration Complete' : '⚠️ Configuration Incomplete', inline: false }
            ])
            .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
    }
};
