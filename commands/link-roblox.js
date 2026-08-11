/**
 * Link Roblox Account Command
 * 
 * Allows users to self-verify by linking their Discord ID to their Roblox account.
 * The username is validated via the Roblox API, the mapping is saved to the
 * verification SQLite database, and the user is granted immediate raid access.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const verificationDb = require('../handlers/verificationDb');
const robloxApi = require('../handlers/robloxApi');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link-roblox')
        .setDescription('Link your Discord account to your Roblox username to gain raid access.')
        .addStringOption(option =>
            option
                .setName('username')
                .setDescription('Your exact Roblox username')
                .setRequired(true)
        ),
    async execute(interaction) {
        const robloxUsername = interaction.options.getString('username', true).trim();
        const guildId = interaction.guild?.id;

        if (!guildId) {
            return interaction.reply({
                content: '❌ This command can only be used inside a server.',
                flags: 64
            });
        }

        // Check if already verified — short-circuit with an informational message
        const existing = await verificationDb.getVerificationData(interaction.user.id, guildId);
        if (existing && existing.is_verified) {
            const alreadyVerifiedEmbed = new EmbedBuilder()
                .setTitle('ℹ️ Already Verified')
                .setDescription('Your Roblox account is already linked and verified. You are authorized to request raids and accept operations.')
                .setColor(0x9B59B6)
                .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                .setTimestamp();

            return interaction.reply({ embeds: [alreadyVerifiedEmbed], flags: 64 });
        }

        // Validate the Roblox username via the API (non-blocking)
        const validation = await robloxApi.validateAndGetAvatar(robloxUsername);
        if (!validation.success) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ Roblox Username Validation Failed')
                .setDescription(`\`\`\`\n${validation.error}\n\`\`\`\nPlease double-check your Roblox username spelling and try again.`)
                .setColor(0xE74C3C)
                .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                .setTimestamp();

            return interaction.reply({ embeds: [errorEmbed], flags: 64 });
        }

        const robloxUserId = validation.userId;
        const robloxDisplayName = validation.displayName;
        const robloxAvatarUrl = validation.avatarUrl;
        const profileLink = `https://www.roblox.com/users/${robloxUserId}/profile`;

        // Persist the Discord ↔ Roblox mapping as fully verified (no moderator gate)
        await verificationDb.directLink(interaction.user.id, {
            robloxUsername,
            robloxDisplayName,
            robloxUserId,
            robloxAvatarUrl,
            robloxPsLink: null,
            killCount: null,
            friendListLink: null,
            verificationId: null
        }, guildId);

        const successEmbed = new EmbedBuilder()
            .setTitle('✅ Roblox Account Linked')
            .setDescription('```\nYour Discord account has been successfully linked\nand verified for raid access.\n```')
            .addFields([
                { name: '🎮 Roblox Profile', value: `[${robloxDisplayName} (@${robloxUsername})](${profileLink})`, inline: false },
                { name: '🆔 Roblox User ID', value: `\`${robloxUserId}\``, inline: true },
                { name: '🛡️ Verification Status', value: 'Verified', inline: true },
                { name: '⚔️ Raid Access', value: 'Granted', inline: true }
            ])
            .setColor(0x9B59B6)
            .setThumbnail(robloxAvatarUrl || interaction.client.user.displayAvatarURL({ size: 64 }))
            .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        await interaction.reply({ embeds: [successEmbed], flags: 64 });
    }
};