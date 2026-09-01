const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('botinfo')
        .setDescription('Display Kakuzu system information'),
    async execute(interaction) {
        const codeBlock = [
            'Kakuzu is a custom-built moderation & raid management system',
            'designed exclusively for BLED ORGANIZATION and its allied clans.',
            'Engineered for precision, built for dominance. 🎯',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '🧩 MODULES',
            '• 🛡️ Moderation System',
            '• ⚔️ Raid Applications',
            '• 🚨 Raid Alerts',
            '• 🤖 Auto Role Assignment',
            '• 📈 Daily Leaderboard',
            '• 📊 Weekly Leaderboard',
            '• 📅 Monthly Leaderboard',
            '• 🔥 Raid Activity Tracking',
            '• 🗂️ Clan Management Utilities',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '🎯 PURPOSE',
            'Streamline raid requests, manage member activity, enhance',
            'clan coordination, and keep the server perfectly organized.',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '🔐 ACCESS     : BLED & Authorized Allied Clans',
            '📊 STATUS     : Operational ✅',
            '👑 DEVELOPER  : yourdad043',
            '🏗️ BUILD      : bled Edition'
        ].join('\n');

        const embed = new EmbedBuilder()
            .setTitle('⚡ KAKUZU // SYSTEM INFO')
            .setDescription('```yaml\n' + codeBlock + '\n```')
            .setColor(0x9B59B6)
            .setThumbnail(interaction.client.user.displayAvatarURL({ size: 256 }))
            .setFooter({ text: 'Kakuzu Verification & Raid System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
};