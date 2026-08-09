const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unsetchannels')
        .setDescription('Clear configured bot channels. Choose which channel(s) to unset.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option
                .setName('target')
                .setDescription('Which channel configuration to clear')
                .setRequired(true)
                .addChoices(
                    { name: 'All channels', value: 'all' },
                    { name: 'Raid Alert Channel', value: 'raid' },
                    { name: 'Raid Result Channel', value: 'result' },
                    { name: 'Verification Logs Channel', value: 'verificationlogs' },
                    { name: 'Verification Result Channel', value: 'verificationresult' }
                )
        ),
    async execute(interaction) {
        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        const target = interaction.options.getString('target', true);

        let cleared = [];

        switch (target) {
            case 'raid':
                settings.raidChannel = null;
                cleared = ['Raid Alert Channel'];
                break;

            case 'result':
                settings.resultChannel = null;
                cleared = ['Raid Result Channel'];
                break;

            case 'verificationlogs':
                settings.verificationLogsChannel = null;
                settings.infoChannel = null; // Clear the legacy info channel fallback too
                cleared = ['Verification Logs Channel'];
                break;

            case 'verificationresult':
                settings.verificationResultChannel = null;
                cleared = ['Verification Result Channel'];
                break;

            case 'all':
            default:
                settings.raidChannel = null;
                settings.resultChannel = null;
                settings.infoChannel = null;
                settings.verificationLogsChannel = null;
                settings.verificationResultChannel = null;
                cleared = ['Raid Alert Channel', 'Raid Result Channel', 'Verification Logs Channel', 'Verification Result Channel'];
                break;
        }

        raidStateManager.saveSettings(guildId, settings);

        await interaction.reply({
            content: '✅ **Channel configuration cleared.**\n\n' +
                     'Cleared:\n' +
                     cleared.map(channel => `• ${channel}`).join('\n') +
                     '\n\nUse `/setchannels`, `/setverificationlogs`, and `/setverificationresults` to reconfigure them.',
            flags: 64
        });
    }
};