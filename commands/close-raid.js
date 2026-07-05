const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('close-raid')
        .setDescription('Close an active raid by raid ID and record a reason')
        .addIntegerOption(option =>
            option.setName('raid_id')
                .setDescription('The unique raid ID to close')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Why this raid is being closed')
                .setRequired(true)
        ),
    async execute(interaction) {
        const raidId = interaction.options.getInteger('raid_id', true);
        const reason = interaction.options.getString('reason', true).trim();
        const raid = raidStateManager.getRaidById(raidId);

        if (!raid) {
            return interaction.reply({ content: 'Raid not found.', ephemeral: true });
        }

        if (!raidStateManager.canCreateRaid || typeof raidStateManager.canCreateRaid !== 'function') {
            return interaction.reply({ content: 'The raid manager is unavailable right now.', ephemeral: true });
        }

        const member = interaction.member;
        const canClose = member && (member.id === raid.requesterId || member.permissions?.has('Administrator'));
        if (!canClose) {
            return interaction.reply({ content: 'Access Denied: Only the Raid Leader or an Administrator can close this.', ephemeral: true });
        }

        const updatedRaid = raidStateManager.closeRaid(raidId, {
            closedBy: interaction.user.id,
            closedByTag: interaction.user.tag,
            closeReason: reason
        });

        if (!updatedRaid) {
            return interaction.reply({ content: 'Unable to close the raid.', ephemeral: true });
        }

        const settings = raidStateManager.loadSettings();
        const alertChannel = await interaction.client.channels.fetch(updatedRaid.channelId).catch(() => null);
        if (alertChannel && alertChannel.isTextBased()) {
            const alertMessage = await alertChannel.messages.fetch(updatedRaid.messageId).catch(() => null);
            if (alertMessage) {
                const closedEmbed = raidStateManager.formatRaidMessage(updatedRaid);
                await alertMessage.edit({ embeds: [closedEmbed], components: [] }).catch(() => null);
            }
        }

        if (settings.resultChannel) {
            const resultChannel = await interaction.client.channels.fetch(settings.resultChannel).catch(() => null);
            if (resultChannel && resultChannel.isTextBased()) {
                await resultChannel.send({
                    content: `🛑 **Raid Status Updated to Closed** | **Raid ID:** \`${updatedRaid.raidId}\` | **Updated By:** <@${interaction.user.id}> | **Reason:** ${reason}`
                });
            }
        }

        return interaction.reply({ content: `Raid #${raidId} has been closed and logged.`, ephemeral: true });
    }
};
