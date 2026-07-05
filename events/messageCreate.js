const raidStateManager = require('../handlers/raidStateManager');
const { pendingResultUploads } = require('../handlers/resultUploadState');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        if (message.author.bot) return;

        const pending = pendingResultUploads.get(message.author.id);
        if (!pending) return;

        const attachment = message.attachments.first();
        if (!attachment || !attachment.contentType?.startsWith('image/')) {
            await message.reply({ content: 'Please upload an image attachment for the raid result.' }).catch(() => null);
            return;
        }

        const raid = raidStateManager.getRaidById(pending.raidId);
        if (!raid) {
            pendingResultUploads.delete(message.author.id);
            return message.reply({ content: 'The raid no longer exists.' }).catch(() => null);
        }

        raidStateManager.setRaidResult(pending.raidId, {
            outcome: pending.outcome,
            imageUrl: attachment.url,
            note: message.content || ''
        });

        const updatedRaid = raidStateManager.getRaidById(pending.raidId);
        if (updatedRaid?.channelId && updatedRaid?.messageId && message.client) {
            const channel = await message.client.channels.fetch(updatedRaid.channelId).catch(() => null);
            if (channel && channel.isTextBased()) {
                const existingMessage = await channel.messages.fetch(updatedRaid.messageId).catch(() => null);
                if (existingMessage) {
                    const embed = raidStateManager.formatRaidResultEmbed(updatedRaid);
                    await existingMessage.edit({ embeds: [embed], components: [] }).catch(() => null);
                }
            }
        }

        pendingResultUploads.delete(message.author.id);
        return message.reply({ content: 'Raid result screenshot uploaded and the embed has been updated.' }).catch(() => null);
    }
};
