const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('checkchannels')
        .setDescription('Show currently configured channels for raid, result and verification.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const settings = raidStateManager.loadSettings(interaction.guild.id);

        const embed = new EmbedBuilder()
            .setTitle('Configured Channels')
            .setColor(0x00AEEF)
            .setTimestamp()
            .addFields([
                { name: 'Raid Alert Channel', value: settings.raidChannel ? `<#${settings.raidChannel}> (
ID: ${settings.raidChannel})` : 'Not set', inline: false },
                { name: 'Raid Result Channel', value: settings.resultChannel ? `<#${settings.resultChannel}> (ID: ${settings.resultChannel})` : 'Not set', inline: false },
                { name: 'Verification Log Channel (pending)', value: settings.infoChannel ? `<#${settings.infoChannel}> (ID: ${settings.infoChannel})` : 'Not set', inline: false },
                { name: 'Verification Result Channel', value: settings.verificationResultChannel ? `<#${settings.verificationResultChannel}> (ID: ${settings.verificationResultChannel})` : 'Not set', inline: false }
            ]);

        await interaction.reply({ embeds: [embed], flags: 64 });
    }
};
