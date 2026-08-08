const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setverificationresult')
        .setDescription('Set the channel where final Accepted/Rejected verification results are posted.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('The channel where final verification result embeds are posted')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread)
        ),
    async execute(interaction) {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ **Access Denied.** You need the **Administrator** permission to configure the verification result channel.', flags: 64 });
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

        return interaction.reply({ content: `✅ Verification result channel set to ${channel}. Final accepted/rejected results will be sent there.`, flags: 64 });
    }
};
