const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Display Kakuzu system information'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('⚡ KAKUZU // SYSTEM INFO')
            .setDescription(
                'Kakuzu is a **custom-built moderation & raid management system** ' +
                'designed exclusively for **Akatsuki Clan** and its **allied clans**. ' +
                'Engineered for precision, built for dominance. 🎯'
            )
            .addFields([
                {
                    name: '🧩 MODULES',
                    value: [
                        '• 🛡️ Moderation System',
                        '• ⚔️ Raid Applications',
                        '• 🚨 Raid Alerts',
                        '• 🤖 Auto Role Assignment',
                        '• 📈 Daily Leaderboard',
                        '• 📊 Weekly Leaderboard',
                        '• 📅 Monthly Leaderboard',
                        '• 🔥 Raid Activity Tracking',
                        '• 🗂️ Clan Management Utilities'
                    ].join('\n'),
                    inline: false
                },
                {
                    name: '🎯 PURPOSE',
                    value: 'Streamline raid requests, manage member activity, enhance clan coordination, and keep the server perfectly organized.',
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