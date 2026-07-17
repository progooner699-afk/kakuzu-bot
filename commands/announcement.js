const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');

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
            .setLabel('Description')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Enter the announcement description/content...')
            .setRequired(true)
            .setMaxLength(4000);

        const field1TitleInput = new TextInputBuilder()
            .setCustomId('ann_field1_title')
            .setLabel('Field 1 - Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('First field title')
            .setRequired(true)
            .setMaxLength(256);

        const field1ValueInput = new TextInputBuilder()
            .setCustomId('ann_field1_value')
            .setLabel('Field 1 - Value')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('First field value')
            .setRequired(true)
            .setMaxLength(1024);

        const field2TitleInput = new TextInputBuilder()
            .setCustomId('ann_field2_title')
            .setLabel('Field 2 - Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Second field title')
            .setRequired(true)
            .setMaxLength(256);

        const field2ValueInput = new TextInputBuilder()
            .setCustomId('ann_field2_value')
            .setLabel('Field 2 - Value')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Second field value')
            .setRequired(true)
            .setMaxLength(1024);

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
            new ActionRowBuilder().addComponents(field1TitleInput),
            new ActionRowBuilder().addComponents(field1ValueInput),
            new ActionRowBuilder().addComponents(field2TitleInput),
            new ActionRowBuilder().addComponents(field2ValueInput),
            new ActionRowBuilder().addComponents(bannerInput)
        );

        await interaction.showModal(modal);
    }
};