const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const robloxAuth = require('../handlers/robloxAuth');

// Admin-only diagnostics panel: shows the LAST GameJoin attempt recorded by
// handlers/robloxAuth.js (getLastGameJoinAttempt) so admins can see exactly
// which detection stage failed on this Render instance without grepping logs.
// SAFETY: only whitelisted fields are ever displayed - never the cookie value,
// cookie length, CSRF token, raw response bodies, IPs or headers.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('raiddebug')
        .setDescription('Show the last Roblox GameJoin attempt and detection diagnostics (admin only).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.editReply({ content: 'This command can only be used inside a server.' }).catch(() => null);
        }

        const cookieConfigured = robloxAuth.isCookieConfigured();
        const last = robloxAuth.getLastGameJoinAttempt();

        const lines = [
            `Cookie configured : ${cookieConfigured ? 'Yes' : 'No'}`
        ];

        if (!last) {
            lines.push('Last GameJoin     : none recorded yet on this process (no detection ran since boot).');
        } else {
            lines.push(
                `Recorded at       : ${new Date(last.at).toISOString()} (${last.at} ms)`,
                `Attempt           : #${last.attempt ?? 'n/a'}`,
                `Guild             : ${last.guildId || 'unknown'}`,
                `Raid              : ${last.raidId || 'n/a'}`,
                `Place ID          : ${last.placeId || 'n/a'}`,
                `Server (job) ID   : ${last.serverId || 'n/a'}`,
                `HTTP status       : ${last.httpStatus ?? 'n/a'}`,
                `Roblox status     : ${last.responseStatus ?? 'n/a'}`,
                `joinScript        : ${last.joinScript ? 'Yes' : 'No'}`,
                `CSRF present      : ${last.csrfPresent ? 'Yes' : 'No'}`,
                `Cookie rotated    : ${last.replacementCookieReceived ? 'Yes' : 'No'}`,
                `Error code        : ${last.errorCode ?? 'n/a'}`,
                `Error message     : ${last.errorMessage ? JSON.stringify(last.errorMessage) : 'n/a'}`,
                `Blocker           : ${last.blocker || 'none'}`
            );
        }

        const embed = new EmbedBuilder()
            .setTitle('🔎 KAKUZU // RAID DEBUG')
            .setDescription('```yaml\n' + lines.join('\n') + '\n```')
            .setColor(cookieConfigured ? 0x57F287 : 0xED4245)
            .setFooter({ text: 'Diagnostics only - cookies, tokens and IPs are never shown.' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] }).catch(() => null);
    }
};