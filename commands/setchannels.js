const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');
const raidChannelSupabase = require('../handlers/raidChannelSupabase');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setchannels')
        .setDescription('Configure the raid result channel. Raid alerts go in temporary channels created in its category.')
        .addChannelOption(option =>
            option
                .setName('result_channel')
                .setDescription('Raid result embeds go here; temp alert channels are created in its category')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        const resultChannel = interaction.options.getChannel('result_channel').id;

        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        settings.resultChannel = resultChannel;

        raidStateManager.saveSettings(guildId, settings);
        try {
            await raidChannelSupabase.setRaidResultChannel(guildId, resultChannel);
            console.log('[setchannels] persisted result channel to Supabase for guild=' + guildId + ': ' + resultChannel);
        } catch (err) {
            console.warn('[setchannels] failed to persist result channel to Supabase:', err?.message || err);
        }
        await interaction.editReply({
            content: '✅ Result channel set to <#' + resultChannel + '>. Raid result embeds will be posted there, and each raid alert gets its own temporary `raid-alert-<id>` channel created in the same category — it is deleted automatically 1 minute after the raid closes. Alerts are posted via the `backupalerts` webhook.',
            flags: 64
        });
    }
};