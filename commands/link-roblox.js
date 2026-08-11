/**
 * Link Roblox Account Command
 *
 * Allows users to self-verify by linking their Discord ID to their Roblox account.
 * Posts an embed with a button in a selected channel for users to link their accounts.
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, ChannelType, PermissionsBitField } = require('discord.js');
const verificationDb = require('../handlers/verificationDb');
const robloxApi = require('../handlers/robloxApi');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link-roblox')
        .setDescription('Setup Roblox linking system - post embed with link button in a channel'),
    async execute(interaction) {
        // Check if user has permission (admin/moderator)
        const member = interaction.member;
        if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && 
            !member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            return interaction.reply({
                content: '? You need Administrator or Manage Messages permission to use this command.',
                flags: 64
            });
        }

        const setupEmbed = new EmbedBuilder()
            .setTitle('?? Roblox Account Linking System')
            .setDescription('Click the button below to select a channel where the Roblox linking embed will be posted.\n\nPlayers will be able to click the link button in that channel and enter their Roblox username to link their account.')
            .setColor(0x9B59B6)
            .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

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
