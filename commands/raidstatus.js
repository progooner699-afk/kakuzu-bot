const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const leaderboardDb = require('../handlers/leaderboardDb');

const tierData = [
    { level: 5, name: 'Rookie' },
    { level: 15, name: 'Active Raider' },
    { level: 50, name: 'Vanguard' },
    { level: 75, name: 'Veteran' },
    { level: 100, name: 'War Leader' },
    { level: 150, name: 'Starlord' },
    { level: 200, name: 'Apex Overlord' },
    { level: 250, name: 'Galactic Warlord' }
];

function getTier(totalRaids) {
    let tier = tierData[0];
    for (const entry of tierData) {
        if (totalRaids >= entry.level) {
            tier = entry;
        } else {
            break;
        }
    }
    return tier;
}

function formatStatusLine(label, value) {
    return `- \`${label} |\` ${value}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('raidstatus')
        .setDescription('Show your raid status, rank, total raids, and level embed.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('The user to view status for')
                .setRequired(false)
        ),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const userId = targetUser.id;
        const raidCount = await leaderboardDb.getRaidCount(userId);
        const rank = await leaderboardDb.getUserRank(userId);
        const tier = getTier(raidCount);
        const tierName = tier.name;
        const playerLevel = Math.max(5, raidCount);
        const rankDisplay = rank > 50 || rank === 0 ? 'No Rank' : `#${rank}`;

        const descriptionLines = [
            `- \`User Name      |\` <@${userId}`,
            `- \`Current Rank   |\` ${rankDisplay}`,
            `- \`Total Raids    |\` ${raidCount}`,
            `- \`Total Requests |\` 0`,
            `- \`Player Level   |\` ${playerLevel}`,
            `- \`Tier          |\` ${tierName}`
        ];

        const embed = new EmbedBuilder()
            .setTitle('🎯 Raid Status Profile')
            .setDescription(descriptionLines.join('\n'))
            .setColor(0x0099ff)
            .setFooter({ text: `Requested by ${interaction.user.tag}` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
