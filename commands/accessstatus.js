'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const guildAccess = require('../handlers/guildAccess');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('accessstatus')
        .setDescription('Show Kakuzu premium access status for a server (support-server moderators only).')
        .addStringOption((o) => o.setName('guild_id').setDescription('Target Discord server ID.').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    deferFirst: false,
    async execute(interaction) {
        const gid = String(interaction.options.getString('guild_id', true) || '').trim();
        // Support-server-only: owner included. Super-admin
        // (yourdad043 / 1392856295807389756) bypasses via authorizeAccessManager.
        const isSuper = guildAccess.isSuperAdmin(interaction.member || interaction.user);
        if (!isSuper) {
            const supportId = guildAccess.getSupportGuildId();
            if (!supportId || String(interaction.guildId || '') !== supportId) {
                return interaction.reply({ content: 'Access denied: this command can only be used inside the Kakuzu Support Server.', flags: 64 }).catch(() => null);
            }
            const ownerId = guildAccess.getBotOwnerId();
            const isOwner = Boolean(ownerId && interaction.user && String(interaction.user.id) === String(ownerId));
            let hasRole = false;
            try {
                const wanted = new Set(guildAccess.getManagerRoleIds());
                const held = interaction.member && interaction.member.roles && interaction.member.roles.cache
                    ? [...interaction.member.roles.cache.keys()].map(String) : [];
                hasRole = held.some((id) => wanted.has(String(id)));
            } catch (_) { hasRole = false; }
            if (!isOwner && !hasRole) {
                return interaction.reply({ content: 'Access denied: you are not authorized to view Kakuzu server access.', flags: 64 }).catch(() => null);
            }
        }
        await interaction.deferReply({ flags: 64 }).catch(() => null);
        let row = null;
        try { row = await guildAccess.fetchGuildRow(gid); }
        catch (e) { return interaction.editReply({ content: 'Status lookup failed. The database may be unavailable.' }).catch(() => null); }
        if (!row) {
            return interaction.editReply({ content: 'No access record for `' + gid + '`.' }).catch(() => null);
        }
        const present = interaction.client.guilds.cache.has(gid);
        const e = new EmbedBuilder()
            .setTitle('Kakuzu Access Status')
            .addFields(
                { name: 'Guild name', value: String(row.guildName || 'Unknown'), inline: true },
                { name: 'Guild ID', value: '`' + row.guildId + '`', inline: true },
                { name: 'Owner ID', value: row.ownerId ? '`' + row.ownerId + '`' : 'Unknown', inline: true },
                { name: 'Kakuzu present', value: present ? 'Yes' : 'No (' + (row.botPresent ? 'record says present' : 'record says left') + ')', inline: true },
                { name: 'Status', value: String(row.accessStatus || 'pending'), inline: true },
                { name: 'Granted by', value: row.grantedBy ? '`' + row.grantedBy + '`' : '—', inline: true },
                { name: 'Granted date', value: row.grantedAt ? new Date(row.grantedAt).toISOString() : '—', inline: true },
                { name: 'Revoked date', value: row.revokedAt ? new Date(row.revokedAt).toISOString() : '—', inline: true },
                { name: 'Owner DM status', value: row.ownerDmStatus || '—', inline: true },
                { name: 'Onboarding channel', value: row.onboardingChannelId ? '<#' + row.onboardingChannelId + '>' : '—', inline: true },
                { name: 'Bot join date', value: row.joinedAt ? new Date(row.joinedAt).toISOString() : '—', inline: true },
            { name: 'Supabase project', value: guildAccess.getSupabaseDashboardUrl() || '—', inline: false },
            )
            .setColor(row.accessStatus === 'granted' ? 0x2ECC71 : 0xE74C3C)
            .setFooter({ text: 'Kakuzu Premium Server Access' })
            .setTimestamp();
        return interaction.editReply({ embeds: [e] }).catch(() => null);
    },
};
