'use strict';
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const guildAccess = require('../handlers/guildAccess');
const accessLog = require('../handlers/accessLog');
const sharedPingDb = require('../handlers/sharedPingDb');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('accessrevoke')
        .setDescription('Revoke Kakuzu premium access for a server (support-server moderators only).')
        .addStringOption((o) => o.setName('guild_id').setDescription('Target Discord server ID.').setRequired(true))
        .addStringOption((o) => o.setName('password').setDescription('Access management password (not needed for super-admin).').setRequired(false))
        .addStringOption((o) => o.setName('reason').setDescription('Optional reason.').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    deferFirst: false,
    async execute(interaction) {
        const gid = String(interaction.options.getString('guild_id', true) || '').trim();
        const password = String(interaction.options.getString('password', false) || '');
        const reason = interaction.options.getString('reason', false);
        const auth = guildAccess.authorizeAccessManager(interaction.member, interaction.guildId, password);
        if (!auth.ok) {
            return interaction.reply({ content: 'Access denied: ' + auth.reason, flags: 64 }).catch(() => null);
        }
        await interaction.deferReply({ flags: 64 }).catch(() => null);
        try {
            let row;
            try {
                row = await guildAccess.revokeGuildAccess(gid, interaction.user.id);
            } catch (err) {
                return interaction.editReply({ content: 'Revoke failed: `' + String((err && err.message) || err).slice(0, 300) + '`' }).catch(() => null);
            }
            try {
                await guildAccess.editOnboardingMessage(interaction.client, gid, 'revoked', { guildId: gid, revokedAt: new Date() });
            } catch (e) { console.warn('[accessrevoke] onboarding edit failed:', (e && e.message) || e); }
            const extra = reason ? ' Reason: ' + String(reason).slice(0, 300) : '';
            let gName = gid;
            let ownerId = row && row.ownerId ? row.ownerId : null;
            try {
                const full = await interaction.client.guilds.fetch(gid).catch(() => null);
                if (full) {
                    if (full.name) gName = full.name;
                    if (!ownerId) { try { const o = await full.fetchOwner(); if (o && o.id) ownerId = o.id; } catch (_) {} }
                }
            } catch (_) {}
            let joinLink = '';
            try { joinLink = await accessLog.createTargetServerInvite(interaction.client, gid); } catch (_) { joinLink = ''; }
            await accessLog.postAccessLog(interaction.client, 'revoked', {
                guildName: gName, guildId: gid, joinLink, ownerId,
                performedById: interaction.user.id, at: new Date(), reason,
            });
            return interaction.editReply({ content: 'Access revoked for `' + gid + '`. The server is now locked.' + extra + ' Logged in #kakuzu-access-logs.' }).catch(() => null);
        } catch (err) {
            console.warn('[accessrevoke] failed:', sharedPingDb.sanitizeError(err));
            return interaction.editReply({ content: 'Revoke failed. Check the logs and try again.' }).catch(() => null);
        }
    },
};
