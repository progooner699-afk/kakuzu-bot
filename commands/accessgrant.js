'use strict';
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const guildAccess = require('../handlers/guildAccess');
const sharedPingDb = require('../handlers/sharedPingDb');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('accessgrant')
        .setDescription('Grant Kakuzu premium access to a server (support-server moderators only).')
        .addStringOption((o) => o.setName('guild_id').setDescription('Target Discord server ID.').setRequired(true))
        .addStringOption((o) => o.setName('password').setDescription('Access management password.').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    deferFirst: false,
    async execute(interaction) {
        const gid = String(interaction.options.getString('guild_id', true) || '').trim();
        const password = String(interaction.options.getString('password', true) || '');
        const auth = guildAccess.authorizeAccessManager(interaction.member, interaction.guildId, password);
        if (!auth.ok) {
            return interaction.reply({ content: 'Access denied: ' + auth.reason, flags: 64 }).catch(() => null);
        }
        await interaction.deferReply({ flags: 64 }).catch(() => null);
        try {
            const targetGuild = await interaction.client.guilds.fetch(gid).catch(() => null);
            if (!targetGuild) {
                return interaction.editReply({ content: 'Target server not found. Kakuzu must currently be present in `' + gid + '`.' }).catch(() => null);
            }
            if (!interaction.client.guilds.cache.has(gid)) {
                return interaction.editReply({ content: 'Kakuzu is not currently present in `' + gid + '`. Ask the owner to invite the bot first.' }).catch(() => null);
            }
            let granted;
            try {
                granted = await guildAccess.grantGuildAccess(gid, interaction.user.id);
            } catch (err) {
                return interaction.editReply({ content: 'Grant failed: `' + String((err && err.message) || err).slice(0, 300) + '`' }).catch(() => null);
            }
            const row = granted.row;
            try {
                let gName = targetGuild.name;
                try { const full = await interaction.client.guilds.fetch(gid); if (full && full.name) gName = full.name; } catch (_) {}
                await guildAccess.editOnboardingMessage(interaction.client, gid, () =>
                    guildAccess.buildGrantedEmbed({ guildName: gName, guildId: gid, grantedAt: row.grantedAt || new Date() }));
            } catch (e) { console.warn('[accessgrant] onboarding edit failed:', (e && e.message) || e); }
            let dmNote = '';
            if (!granted.alreadyGranted) {
                try {
                    let ownerId = row.ownerId;
                    let gName = targetGuild.name;
                    try {
                        const full = await interaction.client.guilds.fetch(gid);
                        if (full) {
                            if (full.name) gName = full.name;
                            try { const o = await full.fetchOwner(); if (o && o.id) ownerId = o.id; } catch (_) {}
                        }
                    } catch (_) {}
                    const ownerUser = ownerId ? await interaction.client.users.fetch(String(ownerId)).catch(() => null) : null;
                    if (ownerUser) {
                        await ownerUser.send(guildAccess.buildOwnerDmPayload({
                            guildName: gName, guildId: gid, moderatorMention: '<@' + interaction.user.id + '>',
                        }));
                        await guildAccess.saveOwnerDmStatus(gid, 'sent');
                        dmNote = ' Owner DM sent.';
                    } else {
                        await guildAccess.saveOwnerDmStatus(gid, 'failed');
                        dmNote = ' Access granted but the owner could not be DMed.';
                    }
                } catch (e) {
                    await guildAccess.saveOwnerDmStatus(gid, 'failed');
                    dmNote = ' Access granted but the owner could not be DMed.';
                }
            } else {
                dmNote = ' Already granted — no duplicate owner DM sent.';
            }
            return interaction.editReply({ content: 'Access granted for **' + targetGuild.name + '** (`' + gid + '`).' + dmNote }).catch(() => null);
        } catch (err) {
            console.warn('[accessgrant] failed:', sharedPingDb.sanitizeError(err));
            return interaction.editReply({ content: 'Grant failed. Check the logs and try again.' }).catch(() => null);
        }
    },
};
