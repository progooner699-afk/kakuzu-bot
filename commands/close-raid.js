const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('close-raid')
        .setDescription('Close an active raid request')
        .addIntegerOption(option =>
            option.setName('raidid')
                .setDescription('The raid ID to close')
                .setRequired(true)
        ),
    async execute(interaction) {
        const raidId = interaction.options.getInteger('raidid', true);
        const raid = raidStateManager.getRaidById(raidId);

        if (!raid) {
            return interaction.reply({ content: 'Raid not found.', ephemeral: true });
        }

        if (!raidStateManager.canCloseRaid(interaction.member, raid)) {
            return interaction.reply({ content: 'Access Denied: Only the Raid Leader or an Administrator can close this.', ephemeral: true });
        }

        const updated = raidStateManager.closeRaid(raidId);
        if (!updated) {
            return interaction.reply({ content: 'Unable to close the raid.', ephemeral: true });
        }

        if (updated.channelId && updated.messageId && interaction.client) {
            const channel = await interaction.client.channels.fetch(updated.channelId).catch(() => null);
            if (channel && channel.isTextBased()) {
                const message = await channel.messages.fetch(updated.messageId).catch(() => null);
                if (message) {
                    await message.edit({
                        embeds: [raidStateManager.formatRaidResultEmbed(updated)],
                        components: []
                    });
                }
            }
        }

        return interaction.reply({ content: `Raid #${raidId} has been closed.`, ephemeral: true });
    }
};
