const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const leaderboardDb = require('../handlers/leaderboardDb');

function formatRankLabel(rank) {
    return rank < 10 ? `Rank ${rank}  |` : `Rank ${rank} |`;
}

async function resolveLeaderboardRows(client, entries) {
    return Promise.all(entries.map(async (entry) => {
        const user = await client.users.fetch(entry.userId).catch(() => null);
        const username = user ? user.username : `Unknown-${entry.userId.slice(0, 6)}`;
        return {
            ...entry,
            displayName: `@${username}`
        };
    }));
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

        const resolved = await resolveLeaderboardRows(interaction.client, entries);
        const lines = resolved.map((entry, index) => {
            const rank = index + 1;
            return `${formatRankLabel(rank)} 👤 ${entry.displayName} - ${entry.raidCount} Raids`;
        });

        const embed = new EmbedBuilder()
            .setTitle('🏆 Raid Helper Leaderboard')
            .setDescription('**Top 15 accepted raid helpers**\nStay active and earn your place on the board.')
            .setColor(0x22b14c)
            .addFields([
                {
                    name: '🟢 Current Standings',
                    value: `\`\`\`text\n${lines.join('\n')}\n\`\`\``
                }
            ])
            .setFooter({ text: `Updated ${new Date().toLocaleString()}` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
