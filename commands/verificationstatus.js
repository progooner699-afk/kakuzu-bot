const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const verificationDb = require('../handlers/verificationDb');
const { formatRobloxProfileValue } = require('../handlers/verificationHelpers');

function formatDate(value) {
    if (!value) return 'Unknown';
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('verificationstatus')
        .setDescription('Check the verification status of a user.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('The user to check (defaults to yourself)')
                .setRequired(false)
        ),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const verificationData = await verificationDb.getVerificationData(targetUser.id, interaction.guild.id);
        const isVerified = Boolean(verificationData?.is_verified);
        const status = verificationData?.status || 'pending';
        const reviewerId = verificationData?.reviewed_by;
        const reviewerTag = reviewerId ? `<@${reviewerId}>` : 'None';
        const robloxProfileValue = formatRobloxProfileValue({
            roblox_display_name: verificationData?.roblox_display_name || verificationData?.roblox_username,
            roblox_username: verificationData?.roblox_username,
            roblox_user_id: verificationData?.roblox_user_id
        });

        const embed = new EmbedBuilder()
            .setTitle(isVerified ? '✅ Verification Status' : '⚠️ Verification Status')
            .setColor(isVerified ? 0x2ECC71 : 0xE74C3C)
            .setDescription(isVerified
                ? `The applicant has been approved and cleared.`
                : `The applicant is still pending or has been rejected.`)
            .addFields([
                { name: '👤 Discord User', value: `<@${targetUser.id}>`, inline: true },
                { name: '🧾 Roblox Profile', value: robloxProfileValue || 'Unknown', inline: true },
                { name: '🛡️ Status', value: isVerified ? 'Verified' : (status === 'rejected' ? 'Rejected' : 'Pending'), inline: true },
                { name: '🧑‍⚖️ Reviewed By', value: reviewerTag, inline: true },
                { name: '🕒 Reviewed At', value: formatDate(verificationData?.reviewed_at), inline: true },
                { name: '📅 Submitted At', value: formatDate(verificationData?.verified_at), inline: true }
            ])
            .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
    }
};