const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    name: 'guildMemberAdd',
    once: false,
    async execute(member, client) {
        // 1. Assign the @lockedping role to restrict channel access
        const settings = raidStateManager.loadSettings();
        if (settings.lockedPingRoleId) {
            try {
                const lockedRole = member.guild.roles.cache.get(settings.lockedPingRoleId);
                if (lockedRole) {
                    await member.roles.add(lockedRole);
                }
            } catch (error) {
                console.warn(`Could not assign locked ping role to ${member.user.tag}: ${error.message}`);
            }
        }

        // 2. Send a sleek welcome embed DM with purple theme
        const welcomeEmbed = new EmbedBuilder()
            .setTitle('👋 Welcome to Akatsuki Clan!')
            .setDescription(
                '```\n' +
                'I am Kakuzu, the clan\'s Verification & Raid Management System.\n' +
                '```\n' +
                'To gain full access to the server, you must complete verification by submitting your TSB information.'
            )
            .addFields([
                {
                    name: '📝 Verification Steps',
                    value: [
                        '1️⃣ Go to the **Waiting Room** or **Verification Channel** in the server.',
                        '2️⃣ Click the **"Submit Info"** button on the verification embed.',
                        '3️⃣ Fill out the form with your Roblox details.',
                        '4️⃣ Wait for a moderator to **Accept** or **Deny** your verification.',
                        '5️⃣ You will receive a DM with the result.'
                    ].join('\n'),
                    inline: false
                },
                {
                    name: '⏳ What Happens Next?',
                    value: 'Once a moderator reviews your submission, you\'ll be notified here via DM whether you were accepted or rejected. If rejected, a reason will be provided.',
                    inline: false
                }
            ])
            .setColor(0x9B59B6) // Sleek purple
            .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
            .setFooter({ text: 'Kakuzu Verification System • Akatsuki Clan', iconURL: client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        try {
            await member.send({ embeds: [welcomeEmbed] });
        } catch (error) {
            // Silently handle if the user has DMs closed
            console.warn(`Could not DM welcome message to ${member.user.tag} (${member.id}): DMs may be closed.`);
        }
    }
};