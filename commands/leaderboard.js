const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const leaderboardDb = require('../handlers/leaderboardDb');

function formatRankLabel(rank) {
    return rank < 10 ? `Rank ${rank}  |` : `Rank ${rank} |`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show the current raid helper leaderboard with the top 15 users.'),
    async execute(interaction) {
        const entries = await leaderboardDb.getTopLeaderboard(15);
        if (!entries || entries.length === 0) {
            return interaction.reply({ content: 'No raid leaderboard data is available yet.', flags: 64 });
        }

        const lines = entries.map((entry, index) => {
            const rank = index + 1;
            return `- \`${formatRankLabel(rank)}\` <@${entry.userId}> \`- ${entry.raidCount} Raids\``;
        });

        const embed = new EmbedBuilder()
            .setTitle('🏆 Raid Helper Leaderboard')
            .setDescription(lines.join('\n'))
            .setColor(0x22b14c)
            .setFooter({ text: `Updated ${new Date().toLocaleString()}` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
