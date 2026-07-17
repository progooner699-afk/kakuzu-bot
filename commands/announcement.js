const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('announcement')
        .setDescription('Create a professional announcement embed'),
    async execute(interaction) {
        const modal = new ModalBuilder()
            .setCustomId('announcement_modal')
            .setTitle('📢 Create Announcement');

        const titleInput = new TextInputBuilder()
            .setCustomId('ann_title')
            .setLabel('Announcement Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the announcement title here...')
            .setRequired(true)
            .setMaxLength(256);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('ann_description')
            .setLabel('Description (Full Content)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Enter the full announcement content here...')
            .setRequired(true)
            .setMaxLength(4000);

        const pingInput = new TextInputBuilder()
            .setCustomId('ann_ping')
            .setLabel('Ping (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. @everyone, @here, or Role ID/Name')
            .setRequired(false)
            .setMaxLength(256);

        const bannerInput = new TextInputBuilder()
            .setCustomId('ann_banner')
            .setLabel('Banner/Logo URL (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Paste an image URL for a banner or logo (optional)')
            .setRequired(false)
            .setMaxLength(1024);

        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(descriptionInput),
            new ActionRowBuilder().addComponents(pingInput),
            new ActionRowBuilder().addComponents(bannerInput)
        );

        await interaction.showModal(modal);
    }
};