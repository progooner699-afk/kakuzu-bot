module.exports = {
    name: 'guildMemberAdd',
    once: false,
    async execute(member, client) {
        const dmMessage = `I am Kakuzu, the clan's Raid Helper and Raid Manager. My purpose is to manage, streamline, and secure this clan. To become a part of our ranks, you must share your legal TSB info so we can verify you are not a spy from an enemy clan. Please head over to the designated verification channel in the server, click the button on the embed, and complete your verification immediately.`;

        try {
            await member.send(dmMessage);
        } catch (error) {
            // Silently handle if the user has DMs closed
            console.warn(`Could not DM welcome message to ${member.user.tag} (${member.id}): DMs may be closed.`);
        }
    }
};