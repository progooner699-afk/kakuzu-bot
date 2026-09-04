const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');
const raidV2 = require('../handlers/raidV2');

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
        const raid = raidStateManager.getRaidById(raidId, interaction.guild.id);

        if (!raid) {
            return interaction.editReply({ content: 'Raid not found.', ephemeral: true });
        }

        const member = interaction.member;
        const canClose = member && (
            member.id === raid.requesterId ||
            member.permissions?.has(PermissionFlagsBits.Administrator) ||
            member.roles.cache.some(role => ['Administrator', 'Management Supervisor', 'Community Manager', 'Senior Moderator', '💣 ‖ SUPREME LEADER'].includes(role.name))
        );
        if (!canClose) {
            return interaction.editReply({ content: 'Access Denied: Only the Raid Leader or an Administrator can close this.', ephemeral: true });
        }

        const updatedRaid = raidStateManager.closeRaid(raidId, {
            closedBy: interaction.user.id,
            closedByTag: interaction.user.tag,
            closeReason: reason
        }, interaction.guild.id);

        if (!updatedRaid) {
            return interaction.editReply({ content: 'Unable to close the raid.', ephemeral: true });
        }

        const settings = raidStateManager.loadSettings(interaction.guild.id);
        // Alerts are authored by the 'backupalerts' webhook -> edit via webhook.
        if (updatedRaid.alertFormat === 'v2') {
            const closedPayload = await raidV2.buildRaidAlertPayload(updatedRaid);
            // Keep the IS_COMPONENTS_V2 flag on edit + log failures.
            await raidStateManager.editRaidAlertMessage(interaction.client, updatedRaid, { flags: raidV2.RAID_ALERT_V2_FLAGS, components: closedPayload.components })
                .catch((err) => console.warn('[raid alert] V2 /close-raid edit failed:', (err && err.message) || err));
        } else {
            const closedEmbeds = raidStateManager.formatRaidMessage(updatedRaid, interaction.guild.id);
            await raidStateManager.editRaidAlertMessage(interaction.client, updatedRaid, { embeds: closedEmbeds, components: [] });
        }

        // Raid closed -> its temporary raid alert channel self-deletes in 1 min.
        raidStateManager.scheduleRaidAlertChannelDeletion(interaction.client, updatedRaid.raidId, interaction.guild.id);

        if (settings.resultChannel) {
            const resultChannel = await interaction.client.channels.fetch(settings.resultChannel).catch(() => null);
            if (resultChannel && resultChannel.isTextBased()) {
                await resultChannel.send({
                    content: `🛑 **Raid Status Updated to Closed** | **Raid ID:** \`${raidStateManager.getRaidDisplayId(updatedRaid)}\` | **Updated By:** <@${interaction.user.id}> | **Reason:** ${reason}`
                });
            }
        }

        return interaction.editReply({ content: `Raid #${raidStateManager.getRaidDisplayId(updatedRaid)} has been closed and logged.`, ephemeral: true });
    }
};
