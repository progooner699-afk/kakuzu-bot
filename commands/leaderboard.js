const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');
const leaderboardDb = require('../handlers/leaderboardDb');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show the current raid helper leaderboard.'),
    async execute(interaction) {
        const topEntries = await leaderboardDb.getTopLeaderboard(20);
        const embeds = await raidStateManager.buildLeaderboardEmbeds(interaction.client, topEntries);
        await interaction.reply({ embeds });
    }
};
