const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const leaderboardDb = require('../handlers/leaderboardDb');
const raidStateManager = require('../handlers/raidStateManager');

function getRankEmoji(rank) {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return '🔹';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Post the live auto-updating elite raid leaderboard.'),
    
    async execute(interaction) {
        // Use flag 64 for ephemeral (hidden) reply
        await interaction.deferReply({ flags: 64 });

        const raidsData = raidStateManager.loadRaids();
        const entries = await leaderboardDb.getTopLeaderboard(15);
        
        if (!entries || entries.length === 0) {
            return interaction.editReply({ content: '❌ No raid leaderboard data is available yet.' });
        }

        // Generate lines using the format: [Rank] • @DiscordUser / [RobloxUser](Link) ➔ X Raids
        const lines = entries.map((entry, index) => {
            const rank = index + 1;
            const emoji = getRankEmoji(rank);
            const rankStr = rank.toString().padEnd(2, ' ');
            const countStr = (entry.raidCount || 0).toString().padStart(3, ' ');
            
            // Logic to find Roblox identity from raid history
            let robloxDisplay = '[Unlinked](https://www.roblox.com)';
            if (raidsData && raidsData.raids) {
                const foundRaid = raidsData.raids.find(r => r.helpers.some(h => (h.userId === entry.userId)));
                const helper = foundRaid ? foundRaid.helpers.find(h => h.userId === entry.userId) : null;
                if (helper && helper.robloxUsername) {
                    robloxDisplay = `[${helper.robloxUsername}](https://www.roblox.com/users/${helper.robloxUserId || 1}/profile)`;
                }
            }

            return `${emoji} \`[ Rank ${rankStr} ]\` • <@${entry.userId}> / ${robloxDisplay} ➔ \`${countStr} Raids\``;
        });

        const embed = new EmbedBuilder()
            .setTitle('🏆 RAID ELITE LEADERBOARD')
            .setDescription(`*The highest performing combat helpers inside the organization.*\n\n${lines.join('\n')}`)
            .setColor(0xbf0000)
            .setThumbnail(interaction.guild.iconURL({ dynamic: true }) || null)
            .setFooter({ text: 'Automated Synchronization • Live Status' })
            .setTimestamp();

        const settings = raidStateManager.loadSettings();

        // Cleanup old message if it exists
        if (settings.leaderboardChannel && settings.leaderboardMessageId) {
            const oldChannel = await interaction.client.channels.fetch(settings.leaderboardChannel).catch(() => null);
            if (oldChannel) {
                const oldMsg = await oldChannel.messages.fetch(settings.leaderboardMessageId).catch(() => null);
                if (oldMsg) await oldMsg.delete().catch(() => null);
            }
        }

        // Post new live message
        const liveMessage = await interaction.channel.send({ embeds: [embed] });

        // Update settings
        settings.leaderboardChannel = interaction.channelId;
        settings.leaderboardMessageId = liveMessage.id;
        raidStateManager.saveSettings(settings);

        await interaction.editReply({ 
            content: `✅ **Live Leaderboard Setup!** It will automatically edit and update right here in <#${interaction.channelId}>.` 
        });
    }
};