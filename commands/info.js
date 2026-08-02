const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Display Kakuzu system information'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('⚡ KAKUZU // SYSTEM INFO')
            .setDescription(
                '```\n' +
                'NAME: Kakuzu\n' +
                'DESCRIPTION: Kakuzu is a custom-built moderation and raid management system designed exclusively for Akatsuki Clan and its allied clans.\n' +
                '```'
            )
            .addFields([
                {
                    name: '🔧 MODULES',
                    value: [
                        '• Moderation System',
                        '• Raid Applications',
                        '• Raid Alerts',
                        '• Auto Role Assignment',
                        '• Daily Leaderboard',
                        '• Weekly Leaderboard',
                        '• Monthly Leaderboard',
                        '• Raid Activity Tracking',
                        '• Clan Management Utilities'
                    ].join('\n'),
                    inline: false
                },
                {
                    name: '🎯 PURPOSE',
                    value: 'To streamline raid requests, manage member activity, improve clan coordination, and maintain server organization.',
                    inline: false
                },
                {
                    name: '🔐 ACCESS',
                    value: 'Akatsuki Clan & Authorized Allied Clans',
                    inline: true
                },
                {
                    name: '📊 STATUS',
                    value: '`Operational ✅`',
                    inline: true
                },
                {
                    name: '👑 DEVELOPER',
                    value: '`nigachad / yourdad043`',
                    inline: true
                },
                {
                    name: '🏗️ BUILD',
                    value: '`Akatsuki Clan Edition`',
                    inline: false
                }
            ])
            .setColor(0x9B59B6) // Sleek purple
            .setThumbnail(interaction.client.user.displayAvatarURL({ size: 256 }))
            .setFooter({ text: 'Kakuzu Verification & Raid System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};