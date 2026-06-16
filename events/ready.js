module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        console.log(`${client.user.tag} is online!`);
        try {
            await client.raidStateManager.syncLeaderboardMessage(client);
        } catch (error) {
            console.error('Failed to sync leaderboard message:', error);
        }
    }
};
