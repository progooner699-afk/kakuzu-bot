'use strict';

/*
 * /adminsetup — interactive, ephemeral builder for the per-guild RAID ADMIN
 * (staff) roles used by the strict raid-action authorization system.
 *
 * STORAGE: permanent source of truth is the Supabase PostgreSQL table
 * `guild_configs` (guild_id TEXT PK, raid_admin_roles TEXT[] DEFAULT '{}',
 * updated_at), written through handlers/raidAdminRoles.js. The in-memory
 * cache is only a performance layer, refreshed AFTER a successful write.
 *
 * STRICT PER-GUILD ISOLATION: the saved role IDs grant raid-admin powers ONLY
 * inside the guild they were configured in — every read/write is keyed by
 * guild_id and checks run against interaction.member of the CURRENT guild.
 *
 * FLOW:
 *   1. /adminsetup (Administrator, guild-only, ephemeral): renders the current
 *      authorized roles with a native RoleSelectMenu (defaults pre-filled) and
 *      a Clear button (two-step confirmation).
 *   2. Selecting roles / confirming a clear UPSERTs the array into
 *      guild_configs for THIS guild only, refreshes the cache and re-renders
 *      the panel. Component presses RE-VERIFY Administrator on every press.
 *
 * CustomIds are namespaced `adminsetup_*` and routed through the SAME
 * interaction hub (events/interactionCreate.js) — no second listener.
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    RoleSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const supabaseDb = require('../handlers/supabaseDb');
const raidAdminRoles = require('../handlers/raidAdminRoles');

// Ephemeral message flag (1 << 6).
const EPHEMERAL_FLAG = 64;
const PANEL_ACCENT_COLOR = 0x5865F2; // blurple
const ROLE_SELECT_ID = 'adminsetup_roles';
const CLEAR_BUTTON_ID = 'adminsetup_clear';
const CLEAR_CONFIRM_ID = 'adminsetup_clear_yes';
const CLEAR_CANCEL_ID = 'adminsetup_clear_no';

/**
 * TRUE only when the ACTOR of this interaction is a Discord Administrator in
 * the SAME guild the interaction is happening in. Strict isolation: a member
 * object belonging to another guild is rejected before any permission check.
 * @param {import('discord.js').Interaction} interaction
 * @returns {boolean}
 */
function canManageRaidAdmins(interaction) {
    const guildId = interaction.guildId || (interaction.guild && interaction.guild.id);
    if (!guildId) return false;
    const member = interaction.member;
    if (member && member.guild && member.guild.id && member.guild.id !== guildId) return false;
    try {
        const perms = (interaction.memberPermissions && typeof interaction.memberPermissions.has === 'function')
            ? interaction.memberPermissions
            : (member && member.permissions);
        return Boolean(perms && perms.has(PermissionFlagsBits.Administrator));
    } catch (_) {
        return false;
    }
}

/**
 * Builds the ephemeral setup panel: current roles embed + RoleSelect (defaults
 * pre-filled with the saved roles) + Clear button (only when roles exist).
 * @param {import('discord.js').Guild|null} guild
 * @param {string[]} roleIds
 * @param {string|null} notice
 * @returns {{embeds: object[], components: object[], flags?: number}}
 */
function buildPanelPayload(guild, roleIds, notice = null) {
    const guildName = (guild && guild.name) || 'this server';
    const lines = [];
    const existing = [];
    for (const id of roleIds) {
        const role = guild && guild.roles && guild.roles.cache ? guild.roles.cache.get(id) : null;
        if (role) {
            existing.push(id);
            lines.push('• <@&' + id + '> — ' + role.name);
        } else {
            lines.push('• `' + id + '` — ⚠️ role no longer exists in this server');
        }
    }
    const description = [
        notice ? notice : null,
        'Members holding any of the roles below — or a Discord **Administrator** — can edit, close and end raids in **' + guildName + '**.',
        '',
        '**Authorized roles:**',
        lines.length ? lines.join('\n') : '_None configured yet._',
        '',
        '> 🔒 Strictly per-server: roles configured here grant raid-admin powers **only in this server**, never in any other server.'
    ].filter(part => part !== null).join('\n');

    const embed = new EmbedBuilder()
        .setTitle('🛡️ Raid Admin Setup')
        .setDescription(description)
        .setColor(PANEL_ACCENT_COLOR)
        .setFooter({ text: 'Stored per-guild in Supabase — guild_configs.raid_admin_roles' })
        .setTimestamp();

    const select = new RoleSelectMenuBuilder()
        .setCustomId(ROLE_SELECT_ID)
        .setPlaceholder('Select the staff roles allowed to manage raids…')
        .setMinValues(1)
        .setMaxValues(raidAdminRoles.MAX_ROLES);
    if (existing.length && typeof select.setDefaultValues === 'function') {
        select.setDefaultValues(existing.slice(0, raidAdminRoles.MAX_ROLES).map(id => ({ id, type: 'role' })));
    }
    const components = [new ActionRowBuilder().addComponents(select)];
    if (roleIds.length) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(CLEAR_BUTTON_ID)
                .setLabel('Clear All Roles')
                .setStyle(ButtonStyle.Danger)
        ));
    }
    return { embeds: [embed], components };
}

async function execute(interaction) {
    if (!interaction.guildId) {
        return interaction.editReply({ content: '❌ **/adminsetup** can only be used inside a server.', flags: EPHEMERAL_FLAG }).catch(() => null);
    }
    if (!canManageRaidAdmins(interaction)) {
        return interaction.editReply({ content: '❌ **Access Denied:** Only a server Administrator can configure raid admin roles.', flags: EPHEMERAL_FLAG }).catch(() => null);
    }
    if (!supabaseDb.isConfigured()) {
        return interaction.editReply({
            content: '❌ DATABASE_URL is not configured on the bot — raid admin roles cannot be loaded. Set DATABASE_URL in the Render environment and try again.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
    }
    // Never throws: reads are cache-first and fail-closed (see raidAdminRoles).
    const roleIds = await raidAdminRoles.getRaidAdminRoles(interaction.guildId);
    const payload = buildPanelPayload(interaction.guild, roleIds);
    payload.flags = EPHEMERAL_FLAG;
    return interaction.editReply(payload).catch(() => null);
}

/**
 * Entry point for every `adminsetup_*` button / role-select interaction.
 * Returns true when handled (so the interaction hub can stop), false when the
 * customId did not belong to this builder.
 * @param {import('discord.js').MessageComponentInteraction} interaction
 * @returns {Promise<boolean>}
 */
async function handleAdminSetupComponent(interaction) {
    const customId = String(interaction.customId || '');
    if (!customId.startsWith('adminsetup_')) return false;
    if (!interaction.guild) return false;

    // Acknowledge FIRST (deferUpdate keeps the same ephemeral message) so the
    // DB write below can never die on Discord's 3-second ack window.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => null);
    }

    const guildId = interaction.guildId || interaction.guild.id;

    // STRICT PER-GUILD re-check on EVERY press: the stale panel proves nothing,
    // so Administrator status is verified against the CURRENT member in the
    // CURRENT guild before any read or write.
    if (!canManageRaidAdmins(interaction)) {
        await interaction.followUp({
            content: '❌ **Access Denied:** Only a server Administrator can change raid admin roles in this server.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        return true;
    }

    if (customId === ROLE_SELECT_ID) {
        const selected = Array.isArray(interaction.values) ? interaction.values : [];
        const next = [];
        const dropped = [];
        for (const raw of selected) {
            const id = String(raw);
            if (id === guildId) continue; // never grant @everyone (its id == guild id)
            if (!interaction.guild.roles.cache.has(id)) { dropped.push(id); continue; }
            if (!next.includes(id)) next.push(id);
        }
        let saved;
        try {
            saved = await raidAdminRoles.saveRaidAdminRoles(guildId, next);
        } catch (err) {
            await interaction.followUp({
                content: '❌ ' + String((err && err.message) || err).slice(0, 300),
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            return true;
        }
        let notice = '✅ Saved **' + saved.length + '** raid admin role(s) for **' + interaction.guild.name + '**.';
        if (dropped.length) notice += '\n⚠️ Skipped ' + dropped.length + ' role(s) that no longer exist in this server.';
        const payload = buildPanelPayload(interaction.guild, saved, notice);
        payload.flags = EPHEMERAL_FLAG;
        await interaction.editReply(payload).catch(() => null);
        return true;
    }

    if (customId === CLEAR_BUTTON_ID) {
        // Two-step confirmation — never a single accidental press.
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(CLEAR_CONFIRM_ID).setLabel('Yes, remove all').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(CLEAR_CANCEL_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
            content: '⚠️ **Remove ALL raid admin roles in ' + interaction.guild.name + '**?\nRequesters and Discord Administrators can still manage raids — nobody else will be able to.',
            embeds: [],
            components: [confirmRow],
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        return true;
    }

    if (customId === CLEAR_CONFIRM_ID) {
        let saved;
        try {
            saved = await raidAdminRoles.saveRaidAdminRoles(guildId, []);
        } catch (err) {
            await interaction.followUp({
                content: '❌ ' + String((err && err.message) || err).slice(0, 300),
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            return true;
        }
        const payload = buildPanelPayload(interaction.guild, saved, '✅ All raid admin roles removed.');
        payload.flags = EPHEMERAL_FLAG;
        await interaction.editReply(payload).catch(() => null);
        return true;
    }

    if (customId === CLEAR_CANCEL_ID) {
        const roleIds = await raidAdminRoles.getRaidAdminRoles(guildId);
        const payload = buildPanelPayload(interaction.guild, roleIds, '❎ Cancelled — nothing changed.');
        payload.flags = EPHEMERAL_FLAG;
        await interaction.editReply(payload).catch(() => null);
        return true;
    }

    // The `adminsetup_` namespace is reserved — always stop the hub dispatch.
    return true;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('adminsetup')
        .setDescription('Configure which roles can manage (edit / close / end) raids in this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    execute,
    handleAdminSetupComponent,
    buildPanelPayload,
    canManageRaidAdmins,
    ROLE_SELECT_ID,
    CLEAR_BUTTON_ID,
    CLEAR_CONFIRM_ID,
    CLEAR_CANCEL_ID
};


