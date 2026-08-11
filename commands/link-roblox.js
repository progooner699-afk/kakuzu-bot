/**
 * Link Roblox Account Command
 *
 * Allows users to self-verify by linking their Discord ID to their Roblox account.
 * Posts an embed with a button in a selected channel for users to link their accounts.
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType, PermissionsBitField } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link-roblox')
        .setDescription('Setup Roblox linking system - post embed with link button in a channel'),
    async execute(interaction) {
        const member = interaction.member;
        if (!member?.permissions?.has(PermissionsBitField.Flags.Administrator) &&
            !member?.permissions?.has(PermissionsBitField.Flags.ManageMessages)) {
            return interaction.reply({
                content: 'You need Administrator or Manage Messages permission to use this command.',
                flags: 64
            }).catch(() => null);
        }

        const footerIconUrl = interaction.client?.user?.displayAvatarURL?.({ size: 64 });
        const setupEmbed = new EmbedBuilder()
            .setTitle('Roblox Account Linking System')
            .setDescription('Select a channel below where the Roblox linking embed will be posted.\n\nPlayers will be able to click the button in that channel and link their account from the interaction.')
            .setColor(0x9B59B6)
            .setTimestamp();

        if (footerIconUrl && /^https?:\/\//i.test(footerIconUrl)) {
            setupEmbed.setFooter({ text: 'Kakuzu Verification System', iconURL: footerIconUrl });
        } else {
            setupEmbed.setFooter({ text: 'Kakuzu Verification System' });
        }

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('select_link_channel')
            .setPlaceholder('Select a channel for the link embed')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

        const row = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.reply({
            embeds: [setupEmbed],
            components: [row],
            flags: 64
        });
    }
};
