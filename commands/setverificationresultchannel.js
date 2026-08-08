const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setverificationresultchannel')
        .setDescription('Set the channel where final Accepted/Rejected verification embeds are posted.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('The channel for final verification result embeds')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread)
        ),
    async execute(interaction) {
        // Administrator only check
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ **Access Denied.** You need the **Administrator** permission to configure verification result channels.',
                flags: 64
            });
        }

        const channel = interaction.options.getChannel('channel');
        if (!channel) {
            return interaction.reply({ content: '❌ Please select a valid text channel.', flags: 64 });
        }

        // Verify the bot can actually use the selected channel.
        const botMember = interaction.guild.members.me;
        if (channel.permissionsFor && botMember) {
            const botPerms = channel.permissionsFor(botMember);
            if (botPerms) {
                if (!botPerms.has(PermissionFlagsBits.SendMessages)) {
                    return interaction.reply({ content: '❌ The bot cannot send messages in that channel. Please grant it the **Send Messages** permission.', flags: 64 });
                }
                if (!botPerms.has(PermissionFlagsBits.EmbedLinks)) {
                    return interaction.reply({ content: '❌ The bot cannot embed links in that channel. Please grant it the **Embed Links** permission.', flags: 64 });
                }
            }
        }

        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        settings.verificationResultChannel = channel.id;
        raidStateManager.saveSettings(guildId, settings);

        await interaction.reply({
            content: `✅ Verification result channel set to ${channel}. Final accepted/rejected embeds will be sent there.`,
            flags: 64
        });
    }
};