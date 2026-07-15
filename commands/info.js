const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Display Kakuzu system information'),
    async execute(interaction) {
        const infoMessage = `[KAKUZU // SYSTEM INFO]

NAME: Kakuzu

DESCRIPTION:
Kakuzu is a custom-built moderation and raid management system designed exclusively for Akatsuki Clan and its allied clans.

MODULES:
- Moderation System
- Raid Applications
- Raid Alerts
- Auto Role Assignment
- Daily Leaderboard
- Weekly Leaderboard
- Monthly Leaderboard
- Raid Activity Tracking
- Clan Management Utilities

PURPOSE:
To streamline raid requests, manage member activity, improve clan coordination, and maintain server organization.

ACCESS:
Akatsuki Clan & Authorized Allied Clans

STATUS:
Operational

DEVELOPER:
nigachad / yourdad043

BUILD:
Akatsuki Clan Edition`;

        await interaction.reply(infoMessage);
    }
};
