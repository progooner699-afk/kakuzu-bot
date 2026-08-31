const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setchannels')
        .setDescription('Configure the raid result channel. Raid alerts go in temporary channels created in its category.')
        .addChannelOption(option =>
            option
                .setName('result_channel')
                .setDescription('Channel where raid result embeds will be posted (temp raid alert channels are created in its category)')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const resultChannel = interaction.options.getChannel('result_channel').id;

        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        settings.resultChannel = resultChannel;

        raidStateManager.saveSettings(guildId, settings);
        await interaction.reply({
            content: '✅ Result channel set to <#' + resultChannel + '>. Raid result embeds will be posted there, and each raid alert gets its own temporary `raid-alert-<id>` channel created in the same category — it is deleted automatically 1 minute after the raid closes. Alerts are posted via the `backupalerts` webhook.',
            flags: 64
        });
    }
};