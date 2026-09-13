'use strict';

/*
 * /pingsetup — interactive, ephemeral Discord builder for Kakuzu's country and
 * region raid-ping roles.
 *
 * STORAGE: permanent source of truth is the shared Supabase PostgreSQL table
 * `guild_ping_settings` (guild_id, country_pings JSONB, region_pings JSONB,
 * updated_at). Nothing lives in JSON files / env vars / the Render filesystem.
 * The in-memory cache (handlers/sharedPingDb.js) is only a performance layer,
 * refreshed AFTER a successful database write.
 *
 * FLOW:
 *   1. /pingsetup (Manage Guild / Administrator, ephemeral): loads the guild's
 *      existing config from the database into a DRAFT and renders the builder.
 *      ONE active session per guild; sessions expire after 15 minutes.
 *   2. Add Country / Add Region -> paginated selectors -> native Discord Role
 *      Select -> draft updated (NOT saved yet).
 *   3. Remove Mapping / View All -> browse and edit the DRAFT.
 *   4. Save Changes -> role ids re-validated against the guild, invalid roles
 *      dropped/warned, complete config UPSERTed, cache updated, success shown.
 *      A database failure shows a truthful error and keeps the session.
 *   5. Reset All -> confirmation step (never a single accidental press) ->
 *      clears the draft; the wipe is only persisted once Save Changes is hit.
 *
 * All customIds are namespaced `pingsetup_<sessionId>_<action>` so sessions in
 * different guilds can never interfere with each other.
 */

const crypto = require('crypto');
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    RoleSelectMenuBuilder
} = require('discord.js');
const sharedPingDb = require('../handlers/sharedPingDb');
const {
    COUNTRIES_SORTED,
    REGIONS,
    flagEmoji,
    getCountry,
    regionLabel
} = require('../handlers/countryCatalog');

// Ephemeral message flag (1 << 6).
const EPHEMERAL_FLAG = 1 << 6;
// Accent color for the setup panel (Kakuzu red).
const PANEL_ACCENT_COLOR = 0x8B0000;
// Success green for confirmations.
const SUCCESS_COLOR = 0x2ECC71;
// Error red for failures.
const ERROR_COLOR = 0xE74C3C;
// Warning amber for invalid roles.
const WARNING_COLOR = 0xF1C40F;

const NL = '\n';

// Select menus cap at 25 options — country browsing is paginated by this.
const COUNTRY_PAGE_SIZE = 25;
// View All renders up to 15 entries per embed page (keeps embeds small).
const VIEW_ALL_PAGE_SIZE = 15;
// Inactive setup sessions are discarded after 15 minutes.
const SESSION_TTL_MS = 15 * 60 * 1000;
// How often expired sessions are swept out of memory.
const SESSION_SWEEP_MS = 60 * 1000;

/* ================================================================== */
/* Sessions                                                            */
/* ================================================================== */

/**
 * One active setup session per guild. `countryPings` / `regionPings` hold the
 * DRAFT — nothing is written to the database until Save Changes.
 * @type {Map<string, object>} guildId -> session
 */
const setupSessions = new Map();

let sweeperTimer = null;

function startSweeper() {
    if (sweeperTimer) return;
    sweeperTimer = setInterval(() => sweepExpiredSessions(), SESSION_SWEEP_MS);
    // Do not keep the bot process alive just because a session is open.
    sweeperTimer.unref && sweeperTimer.unref();
}

/** Clears expired sessions safely (also the lazy path used on interactions). */
function sweepExpiredSessions() {
    const now = Date.now();
    for (const [guildId, session] of setupSessions) {
        if (!session || now > session.expiresAt) setupSessions.delete(guildId);
    }
}

function stopSweeper() {
    if (sweeperTimer) {
        clearInterval(sweeperTimer);
        sweeperTimer = null;
    }
}

function newSessionId() {
    return crypto.randomBytes(6).toString('hex').toLowerCase();
}

function createSession(interaction) {
    const session = {
        sessionId: newSessionId(),
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        countryPings: {},   // draft: { 'IN': roleId, ... }
        regionPings: {},    // draft: { 'ASIA': roleId, ... }
        view: 'main',
        notice: null,       // transient one-line message above the embed
        countryPage: 1,
        removeMode: 'country',
        removePage: 1,
        viewAllPage: 1,
        pendingCountry: null,
        pendingRegion: null,
        dbStatus: null,     // cached checkDatabaseHealth() result
        dbStatusAt: 0,
        lastSaved: null,    // snapshot shown on the save-success screen
        expiresAt: Date.now() + SESSION_TTL_MS
    };
    setupSessions.set(interaction.guild.id, session);
    startSweeper();
    return session;
}

function touchSession(session) {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
}

function customId(session, action) {
    return `pingsetup_${session.sessionId}_${action}`;
}

/** Parses `pingsetup_<sessionId>_<action>` into { sessionId, action }. */
function parsePingSetupCustomId(raw) {
    const match = /^pingsetup_([a-f0-9]+)_(.*)$/i.exec(String(raw || ''));
    if (!match) return null;
    return { sessionId: match[1], action: match[2] };
}

/* ================================================================== */
/* Permissions / roles                                                 */
/* ================================================================== */

function canManagePings(interaction) {
    const perms = interaction.memberPermissions;
    if (!perms) return false;
    return perms.has(PermissionsBitField.Flags.ManageGuild) ||
        perms.has(PermissionsBitField.Flags.Administrator);
}

/**
 * Returns the guild's role list (@everyone filtered out, managed roles
 * excluded), fetching from Discord only when the cache is genuinely empty.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @returns {Promise<object[]>}
 */
async function listGuildRoles(client, guildId) {
    let guild = client && client.guilds ? client.guilds.cache.get(guildId) : null;
    if (!guild && client && client.guilds && typeof client.guilds.fetch === 'function') {
        guild = await client.guilds.fetch(guildId).catch(() => null);
    }
    if (!guild || !guild.roles) return [];
    if (guild.roles.cache.size === 0 && typeof guild.roles.fetch === 'function') {
        await guild.roles.fetch().catch(() => null);
    }
    const roles = guild.roles.cache ? [...guild.roles.cache.values()] : [];
    return roles.filter((role) => role && role.id !== guildId && !Boolean(role.managed));
}

/**
 * A role id counts as valid for pinging when the role exists in the guild,
 * is not @everyone, is not managed, and can be mentioned.
 * @param {Map<string, object>} roleMap roleId -> role
 * @param {string|null|undefined} roleId
 * @returns {boolean}
 */
function isRoleValid(roleMap, roleId) {
    if (!roleId) return false;
    const role = roleMap.get(String(roleId));
    if (!role) return false;
    if (role.mentionable === false) return false;
    return true;
}

function buildRoleMap(roles) {
    const map = new Map();
    for (const role of roles || []) {
        if (role && role.id && role.id !== '@everyone') map.set(String(role.id), role);
    }
    return map;
}

/** Sorted (by English name) list of catalog countries as { code, name, region }. */
function sortedCountries() {
    return COUNTRIES_SORTED;
}

/**
 * Pure pagination helper. Returns the page slice plus navigation metadata.
 * @param {*[]} items
 * @param {number} page 1-based
 * @param {number} pageSize
 * @returns {{ slice: *[], page: number, pageCount: number, hasPrev: boolean, hasNext: boolean }}
 */
function paginate(items, page, pageSize) {
    const total = Array.isArray(items) ? items.length : 0;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, Number(page) || 1), pageCount);
    const start = (safePage - 1) * pageSize;
    return {
        slice: items.slice(start, start + pageSize),
        page: safePage,
        pageCount,
        hasPrev: safePage > 1,
        hasNext: safePage < pageCount
    };
}

/** Builds the ≤25 options for one paginated page of the country selector. */
function buildCountrySelectOptions(page) {
    const paged = paginate(sortedCountries(), page, COUNTRY_PAGE_SIZE);
    const options = paged.slice.map((country) => new StringSelectMenuOptionBuilder()
        .setLabel(`${flagEmoji(country.code)} ${country.name} (${country.code})`)
        .setValue(country.code));
    return { options, page: paged.page, pageCount: paged.pageCount, hasPrev: paged.hasPrev, hasNext: paged.hasNext };
}

/** Human label for a country code ('IN' -> 'India (IN)') or raw fallback. */
function countryLabel(code) {
    const entry = getCountry(code);
    return entry ? `${entry.name} (${entry.code})` : String(code);
}

/** Human label for a region key ('ASIA' -> 'Asia'). */
function regionLabelSafe(key) {
    return regionLabel(key);
}

/* ================================================================== */
/* Embed + component builders                                          */
/* ================================================================== */

const DB_STATUS_TTL_MS = 60 * 1000;

/** Cached database status for the status line (refreshed once/min). */
async function resolveDbStatus(session, force) {
    const now = Date.now();
    if (!force && session.dbStatus && now - session.dbStatusAt < DB_STATUS_TTL_MS) {
        return session.dbStatus;
    }
    session.dbStatus = await sharedPingDb.checkDatabaseHealth().catch(() => ({ ok: false, configured: true }));
    session.dbStatusAt = Date.now();
    return session.dbStatus;
}

function dbStatusText(status) {
    if (!status || status.ok === undefined) return '🟡 Database: checking…';
    if (status.ok) return '🟢 Database: connected';
    if (status.configured === false) return '🟠 Database: not configured — set DATABASE_URL in Render';
    return '🟠 Database: temporarily unavailable — stored settings kept in cache';
}

function regionEmoji(key) {
    for (const region of REGIONS) {
        if (region.key === String(key || '').trim().toUpperCase()) return region.emoji;
    }
    return '🌐';
}

function countInvalidMappings(map, roleMap) {
    let n = 0;
    for (const roleId of Object.values(map || {})) {
        if (!isRoleValid(roleMap, roleId)) n += 1;
    }
    return n;
}

/** One embed line, e.g. `• 🇮🇳 India (\`IN\`) → <@&111> ✅`. */
function mappingLine({ label, code, roleId }, roleMap) {
    const valid = isRoleValid(roleMap, roleId);
    const mention = roleId ? `<@&${roleId}>` : '(none)';
    const mark = valid ? '✅' : '⚠️ invalid/deleted role';
    return `• ${label} \`${code}\` → ${mention} ${mark}`;
}

/** Draft snapshot summary used by Save / View All renderers. */
function draftEntries(countryPings, regionPings) {
    const entries = [];
    for (const [code, roleId] of Object.entries(countryPings || {})) {
        const country = getCountry(code);
        entries.push({
            type: 'country',
            code,
            label: country ? `${flagEmoji(code)} ${country.name}` : flagEmoji(code) + ' ' + code,
            roleId: String(roleId)
        });
    }
    for (const [code, roleId] of Object.entries(regionPings || {})) {
        entries.push({
            type: 'region',
            code,
            label: `${regionEmoji(code)} ${regionLabelSafe(code)}`,
            roleId: String(roleId)
        });
    }
    return entries;
}

function buildMainEmbed(session, roleMap) {
    const status = dbStatusText(session.dbStatus);
    const countryCount = Object.keys(session.countryPings).length;
    const regionCount = Object.keys(session.regionPings).length;
    const invalidCount = countInvalidMappings(session.countryPings, roleMap) +
        countInvalidMappings(session.regionPings, roleMap);

    const lines = [];
    if (session.notice) lines.push(session.notice + NL);

    lines.push('Configure which roles Kakuzu should ping when a raid\'s country or region is detected.' + NL);

    lines.push(`**Country Pings** (${countryCount})`);
    if (countryCount === 0) {
        lines.push('> None configured yet — press **Add Country** below.');
    } else {
        const entries = draftEntries(session.countryPings, {});
        const shown = entries.slice(0, 8);
        for (const entry of shown) lines.push(mappingLine(entry, roleMap));
        if (entries.length > shown.length) lines.push(`> … and ${entries.length - shown.length} more — press **View All**.`);
    }

    lines.push(NL + `**Region Pings** (${regionCount})`);
    if (regionCount === 0) {
        lines.push('> None configured yet — press **Add Region** below.');
    } else {
        const entries = draftEntries({}, session.regionPings);
        for (const entry of entries) lines.push(mappingLine(entry, roleMap));
    }

    lines.push(NL + '**Ping Priority**' + NL +
        'Country role first, region role as fallback. Never both.');

    lines.push(NL + status + ` · ${countryCount} countries · ${regionCount} regions` +
        (invalidCount ? ` · ⚠️ ${invalidCount} invalid role(s)` : ''));

    return new EmbedBuilder()
        .setTitle('🗺️ Kakuzu Ping Setup')
        .setColor(PANEL_ACCENT_COLOR)
        .setDescription(lines.join(NL));
}

function countriesCount() {
    return COUNTRIES_SORTED.length;
}

function buildCountryAddEmbed(session) {
    const pageCount = Math.max(1, Math.ceil(countriesCount() / COUNTRY_PAGE_SIZE));
    return new EmbedBuilder()
        .setTitle(`🌍 Add Country Ping — Page ${session.countryPage}/${pageCount}`)
        .setDescription('Pick a country. After that you will choose which **role** Kakuzu pings for it.' + NL +
            '> Use **Prev / Next** to browse every supported country (alphabetical).')
        .setColor(PANEL_ACCENT_COLOR);
}

function buildRegionAddEmbed(session) {
    return new EmbedBuilder()
        .setTitle('🌏 Add Region Ping')
        .setDescription('Pick a region. After that you will choose which **role** Kakuzu pings for it.' + NL +
            '> When a raid has a country mapping, the country role wins; otherwise this region role is the fallback.')
        .setColor(PANEL_ACCENT_COLOR);
}

function buildRolePickEmbed(session) {
    const target = session.pendingCountry
        ? `${flagEmoji(session.pendingCountry)} ${countryLabel(session.pendingCountry)}`
        : `${regionEmoji(session.pendingRegion)} ${regionLabelSafe(session.pendingRegion)}`;
    const kind = session.pendingCountry ? 'country' : 'region';
    return new EmbedBuilder()
        .setTitle('🎭 Choose Role')
        .setDescription(`Assign the role Kakuzu should ping for **${target}**.` + NL +
            '> Only mentionable roles can be selected (Discord enforces this).' + NL +
            `> This updates the **draft** — press **Save Changes** later to persist the ${kind} ping.`)
        .setColor(PANEL_ACCENT_COLOR);
}

function buildRemoveModeEmbed(session) {
    return new EmbedBuilder()
        .setTitle('🗑️ Remove Mapping')
        .setDescription('Choose which kind of mapping to remove. Only **configured** mappings appear on the next step.')
        .setColor(PANEL_ACCENT_COLOR);
}

function buildRemovePickEmbed(session, paged) {
    const kind = session.removeMode === 'country' ? 'Country' : 'Region';
    return new EmbedBuilder()
        .setTitle(`🗑️ Remove ${kind} Mapping — Page ${paged.page}/${paged.pageCount}`)
        .setDescription('Pick a mapping to remove from the **draft**. Nothing is saved until **Save Changes** is pressed.')
        .setColor(PANEL_ACCENT_COLOR);
}

function buildViewAllEmbed(session, paged, roleMap) {
    const lines = [];
    lines.push('Every drafted country + region ping mapping for this server:' + NL);
    if (!paged.slice.length) lines.push('> Nothing configured yet.');
    paged.slice.forEach((entry, i) => {
        const valid = isRoleValid(roleMap, entry.roleId);
        const mention = entry.roleId ? `<@&${entry.roleId}>` : '(none)';
        const mark = valid ? '✅' : '❌ invalid';
        const num = String((paged.page - 1) * VIEW_ALL_PAGE_SIZE + i + 1);
        lines.push(`**${num}.** ${entry.label} — ${mention} \`${entry.roleId}\` ${mark}`);
    });
    return new EmbedBuilder()
        .setTitle(`📋 View All Pings — Page ${paged.page}/${paged.pageCount}`)
        .setDescription(lines.join(NL))
        .setColor(PANEL_ACCENT_COLOR);
}

function buildResetEmbed(session) {
    return new EmbedBuilder()
        .setTitle('🗑️ Reset All Pings')
        .setDescription('⚠️ This will remove every country and region ping configured for this server.' + NL +
            '> This clears the **draft**. The wipe is only written to the database once you press **Save Changes**.')
        .setColor(WARNING_COLOR);
}

function buildSaveSuccessEmbed(session) {
    const saved = session.lastSaved || { countryPings: {}, regionPings: {} };
    const lines = ['✅ Your changes were saved to the database.' + NL];
    const countryEntries = draftEntries(saved.countryPings, {});
    const regionEntries = draftEntries({}, saved.regionPings);

    lines.push(`**Country Pings** (${countryEntries.length})`);
    if (countryEntries.length) {
        countryEntries.forEach((e) => lines.push(mappingLine(e, new Map())));
    } else {
        lines.push('> None');
    }
    lines.push(NL + `**Region Pings** (${regionEntries.length})`);
    if (regionEntries.length) {
        regionEntries.forEach((e) => lines.push(mappingLine(e, new Map())));
    } else {
        lines.push('> None');
    }
    if (session.lastRemoveWarnings && session.lastRemoveWarnings.length) {
        lines.push(NL + '⚠️ Removed invalid/deleted role(s): `' + session.lastRemoveWarnings.join('`, `') + '`');
    }
    return new EmbedBuilder()
        .setTitle('✅ Ping Settings Saved')
        .setColor(SUCCESS_COLOR)
        .setDescription(lines.join(NL));
}

function buildSaveErrorEmbed(session, errorDetail) {
    const lines = [];
    lines.push('❌ The database is currently unavailable. Your changes were **not saved**. Please try again.' + NL);
    if (errorDetail) lines.push('> Technical detail (sanitized): `' + String(errorDetail).slice(0, 400) + '`');
    lines.push(NL + '> Your draft is still open — press **Back to Setup** to keep editing, then **Save Changes** again.');
    return new EmbedBuilder()
        .setTitle('⛔ Save Failed')
        .setColor(ERROR_COLOR)
        .setDescription(lines.join(NL));
}

/* ================================================================== */
/* Component rows / payload                                            */
/* ================================================================== */

function mainRows(session) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(customId(session, 'addcountry')).setLabel('🌍 Add Country').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(customId(session, 'addregion')).setLabel('🌏 Add Region').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(customId(session, 'remove')).setLabel('🗑️ Remove Mapping').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(customId(session, 'viewall')).setLabel('📋 View All').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(customId(session, 'save')).setLabel('💾 Save Changes').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(customId(session, 'reset')).setLabel('🧹 Reset All').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(customId(session, 'cancel')).setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary)
        )
    ];
}

function prevNextBackRows(session, actionPrefix, hasPrev, hasNext, backAction) {
    const buttons = [
        new ButtonBuilder()
            .setCustomId(customId(session, actionPrefix + 'prev'))
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasPrev),
        new ButtonBuilder()
            .setCustomId(customId(session, actionPrefix + 'next'))
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasNext),
        new ButtonBuilder()
            .setCustomId(customId(session, backAction))
            .setLabel('↩ Back')
            .setStyle(ButtonStyle.Secondary)
    ];
    return [new ActionRowBuilder().addComponents(...buttons)];
}

function countryAddRows(session, paged) {
    const select = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'countrysel'))
        .setPlaceholder('Choose a country…')
        .setMinValues(1)
        .setMaxValues(1);
    select.addOptions(...paged.options);
    return [
        new ActionRowBuilder().addComponents(select),
        ...prevNextBackRows(session, 'country', paged.hasPrev, paged.hasNext, 'backmain')
    ];
}

function regionAddRows(session) {
    const select = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'regionpick'))
        .setPlaceholder('Choose a region…')
        .setMinValues(1)
        .setMaxValues(1);
    REGIONS.forEach((region) => {
        select.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(`${region.emoji} ${region.label}`)
                .setDescription(`Region key: ${region.key}`)
                .setValue(region.key)
        );
    });
    const back = new ButtonBuilder()
        .setCustomId(customId(session, 'backmain'))
        .setLabel('↩ Back')
        .setStyle(ButtonStyle.Secondary);
    return [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back)];
}

function rolePickRows(session) {
    const select = new RoleSelectMenuBuilder()
        .setCustomId(customId(session, 'rolesel'))
        .setPlaceholder('Choose the role to ping…')
        .setMinValues(1)
        .setMaxValues(1);
    const back = new ButtonBuilder()
        .setCustomId(customId(session, 'backmain'))
        .setLabel('↩ Back')
        .setStyle(ButtonStyle.Secondary);
    return [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back)];
}

function removeModeRows(session) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(customId(session, 'rmmode_country')).setLabel('🌍 Country Mapping').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(customId(session, 'rmmode_region')).setLabel('🌏 Region Mapping').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(customId(session, 'backmain')).setLabel('↩ Back').setStyle(ButtonStyle.Secondary)
    );
    return [row];
}

function removePickRows(session, paged, options) {
    const select = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'rmpick'))
        .setPlaceholder('Choose a mapping to remove…')
        .setMinValues(1)
        .setMaxValues(1);
    select.addOptions(...options);
    return [
        new ActionRowBuilder().addComponents(select),
        ...prevNextBackRows(session, 'rm', paged.hasPrev, paged.hasNext, 'rmback')
    ];
}

function viewAllRows(session, paged) {
    return prevNextBackRows(session, 'va', paged.hasPrev, paged.hasNext, 'backmain');
}

function resetRows(session) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(customId(session, 'resetconfirm')).setLabel('⚠️ Confirm Reset').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(customId(session, 'resetback')).setLabel('↩ Go Back').setStyle(ButtonStyle.Secondary)
    );
    return [row];
}

function saveSuccessRows(session) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(customId(session, 'savecontinue')).setLabel('↩ Continue Editing').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(customId(session, 'close')).setLabel('✅ Close Setup').setStyle(ButtonStyle.Success)
    );
    return [row];
}

function saveErrorRows(session) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(customId(session, 'backmain')).setLabel('↩ Back to Setup').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(customId(session, 'close')).setLabel('❌ Close Setup').setStyle(ButtonStyle.Secondary)
    );
    return [row];
}

/** Currently configured mappings of one type (draft), for Remove/ViewAll. */
function removeableEntries(session) {
    if (session.removeMode === 'country') return draftEntries(session.countryPings, {});
    return draftEntries({}, session.regionPings);
}

/** Builds the select options for one remove page (≤25 per page). */
function buildRemoveSelectOptions(session, paged) {
    return paged.slice.map((entry) => new StringSelectMenuOptionBuilder()
        .setLabel(entry.label)
        .setValue(entry.code)
        .setDescription(String(entry.roleId)));
}

/**
 * Renders the current session view into an editReply payload.
 * @param {object} session
 * @param {Map<string, object>} roleMap
 * @returns {{ embeds: object[], components: object[] }}
 */
function buildPayloadForView(session, roleMap) {
    let embed;
    let rows;
    switch (session.view) {
        case 'country': {
            const paged = buildCountrySelectOptions(session.countryPage);
            embed = buildCountryAddEmbed(session);
            rows = countryAddRows(session, paged);
            break;
        }
        case 'region':
            embed = buildRegionAddEmbed(session);
            rows = regionAddRows(session);
            break;
        case 'role':
            embed = buildRolePickEmbed(session);
            rows = rolePickRows(session);
            break;
        case 'remove_mode':
            embed = buildRemoveModeEmbed(session);
            rows = removeModeRows(session);
            break;
        case 'remove_pick': {
            const paged = paginate(removeableEntries(session), session.removePage, COUNTRY_PAGE_SIZE);
            const options = buildRemoveSelectOptions(session, paged);
            embed = buildRemovePickEmbed(session, paged);
            rows = removePickRows(session, paged, options);
            break;
        }
        case 'viewall': {
            const entries = draftEntries(session.countryPings, session.regionPings);
            const paged = paginate(entries, session.viewAllPage, VIEW_ALL_PAGE_SIZE);
            embed = buildViewAllEmbed(session, paged, roleMap);
            rows = viewAllRows(session, paged);
            break;
        }
        case 'reset':
            embed = buildResetEmbed(session);
            rows = resetRows(session);
            break;
        case 'save_success':
            embed = buildSaveSuccessEmbed(session);
            rows = saveSuccessRows(session);
            break;
        case 'save_error':
            embed = buildSaveErrorEmbed(session, session.lastError);
            rows = saveErrorRows(session);
            break;
        case 'main':
        default:
            embed = buildMainEmbed(session, roleMap);
            rows = mainRows(session);
            break;
    }
    return { embeds: [embed], components: rows };
}

/** editReply helper used by every view transition. */
async function renderView(interaction, session, roleMap) {
    const payload = buildPayloadForView(session, roleMap);
    payload.flags = EPHEMERAL_FLAG;
    await interaction.editReply(payload).catch(() => null);
}

/* ================================================================== */
/* Component interaction handler                                        */
/* ================================================================== */

/**
 * Entry point for every `pingsetup_*` button / select interaction.
 * Returns true when handled (so the interaction hub can stop), false when the
 * customId did not belong to this builder.
 * @param {import('discord.js').MessageComponentInteraction} interaction
 * @returns {Promise<boolean>}
 */
async function handlePingSetupComponent(interaction) {
    const parsed = parsePingSetupCustomId(interaction.customId);
    if (!parsed || !interaction.guild) return false;

    // Acknowledge the component FIRST (deferUpdate keeps the same ephemeral
    // message) so every later editReply() below works and nothing dies on
    // Discord's 3-second ack window (DB reads + guild role fetches follow).
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => null);
    }

    sweepExpiredSessions();

    const session = setupSessions.get(interaction.guild.id);
    if (!session) {
        await interaction.editReply({
            content: '⏳ This ping setup session has expired or was closed. Run **/pingsetup** again to open a new one.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        return true;
    }
    if (session.sessionId !== parsed.sessionId) {
        await interaction.editReply({
            content: '⚠️ This panel belongs to a different setup session. Run **/pingsetup** to open a fresh one.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        return true;
    }
    if (interaction.user && interaction.user.id !== session.userId) {
        await interaction.editReply({
            content: '🔒 Only the administrator who opened this setup panel can change it. They can press **Cancel / Close**, or it expires after 15 minutes of inactivity.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        return true;
    }
    if (!canManagePings(interaction)) {
        await interaction.editReply({
            content: '🔒 You need the **Manage Server** permission (Manage Guild or Administrator) to change ping settings.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        return true;
    }
    touchSession(session);

    // Resolve the guild role list once per interaction (cache-first).
    const roles = await listGuildRoles(interaction.client, interaction.guild.id);
    const roleMap = buildRoleMap(roles);

    if (typeof interaction.isRoleSelectMenu === 'function' && interaction.isRoleSelectMenu()) {
        return handleRoleSelect(interaction, session, parsed, roleMap);
    }
    if (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu()) {
        return handleStringSelect(interaction, session, parsed, roleMap);
    }
    return handleButton(interaction, session, parsed, roleMap);
}

/** Native Discord Role Select submit — persists the chosen role in the draft. */
async function handleRoleSelect(interaction, session, parsed, roleMap) {
    const roleId = (interaction.values && interaction.values.length)
        ? String(interaction.values[0]) : null;
    session.notice = null;

    if (!roleId || !isRoleValid(roleMap, roleId)) {
        session.notice = '⚠️ That role can no longer be mentioned or does not exist. Pick another one.';
        session.view = 'main';
        return renderView(interaction, session, roleMap);
    }

    if (session.pendingCountry) {
        session.countryPings[session.pendingCountry.toUpperCase()] = roleId;
        session.notice = `✅ ${flagEmoji(session.pendingCountry)} ${countryLabel(session.pendingCountry)} → <@&${roleId}> (draft)`;
        session.pendingCountry = null;
    } else if (session.pendingRegion) {
        session.regionPings[session.pendingRegion] = roleId;
        session.notice = `✅ ${regionLabelSafe(session.pendingRegion)} → <@&${roleId}> (draft)`;
        session.pendingRegion = null;
    }
    session.view = 'main';
    return renderView(interaction, session, roleMap);
}

/** String select submit: country pick, region pick, remove pick. */
async function handleStringSelect(interaction, session, parsed, roleMap) {
    const value = (interaction.values && interaction.values.length)
        ? String(interaction.values[0]).trim() : '';
    session.notice = null;

    switch (parsed.action) {
        case 'countrysel': {
            if (!getCountry(value)) {
                session.notice = '⚠️ Unknown country — please pick from the list.';
                session.view = 'country';
            } else {
                session.pendingCountry = value.toUpperCase();
                session.pendingRegion = null;
                session.view = 'role';
            }
            break;
        }
        case 'regionpick': {
            const normalized = value.toUpperCase();
            if (!REGIONS.some((r) => r.key === normalized)) {
                session.notice = '⚠️ Unknown region — please pick from the list.';
                session.view = 'region';
            } else {
                session.pendingRegion = normalized;
                session.pendingCountry = null;
                session.view = 'role';
            }
            break;
        }
        case 'rmpick': {
            if (session.removeMode === 'country' && session.countryPings[value]) {
                delete session.countryPings[value];
                session.notice = `🗑️ Removed **${countryLabel(value)}** from the draft.`;
            } else if (session.removeMode === 'region' && session.regionPings[value]) {
                delete session.regionPings[value];
                session.notice = `🗑️ Removed **${regionLabelSafe(value)}** from the draft.`;
            }
            session.view = 'main';
            break;
        }
        default:
            return false;
    }
    return renderView(interaction, session, roleMap);
}

/** Button dispatch for every `pingsetup_*` button customId. */
async function handleButton(interaction, session, parsed, roleMap) {
    session.notice = null;
    switch (parsed.action) {
        case 'addcountry':
            session.countryPage = 1;
            session.view = 'country';
            break;
        case 'addregion':
            session.view = 'region';
            break;
        case 'countryprev':
            session.countryPage = Math.max(1, session.countryPage - 1);
            session.view = 'country';
            break;
        case 'countrynext': {
            const pageCount = Math.max(1, Math.ceil(countriesCount() / COUNTRY_PAGE_SIZE));
            session.countryPage = Math.min(pageCount, session.countryPage + 1);
            session.view = 'country';
            break;
        }
        case 'remove':
            session.view = 'remove_mode';
            break;
        case 'rmmode_country':
            session.removeMode = 'country';
            session.removePage = 1;
            session.view = 'remove_pick';
            break;
        case 'rmmode_region':
            session.removeMode = 'region';
            session.removePage = 1;
            session.view = 'remove_pick';
            break;
        case 'rmprev':
            session.removePage = Math.max(1, session.removePage - 1);
            session.view = 'remove_pick';
            break;
        case 'rmnext': {
            const pageCount = Math.max(1, Math.ceil(removeableEntries(session).length / COUNTRY_PAGE_SIZE));
            session.removePage = Math.min(pageCount, session.removePage + 1);
            session.view = 'remove_pick';
            break;
        }
        case 'rmback':
            session.view = 'main';
            break;
        case 'viewall':
            session.viewAllPage = 1;
            session.view = 'viewall';
            break;
        case 'vaprev':
            session.viewAllPage = Math.max(1, session.viewAllPage - 1);
            session.view = 'viewall';
            break;
        case 'vanext': {
            const pageCount = Math.max(1, Math.ceil(
                draftEntries(session.countryPings, session.regionPings).length / VIEW_ALL_PAGE_SIZE
            ));
            session.viewAllPage = Math.min(pageCount, session.viewAllPage + 1);
            session.view = 'viewall';
            break;
        }
        case 'vaback':
            session.view = 'main';
            break;
        case 'reset':
            session.view = 'reset';
            break;
        case 'resetconfirm':
            session.countryPings = {};
            session.regionPings = {};
            session.notice = '🗑️ Draft cleared — press **Save Changes** to persist the removal of every country and region ping.';
            session.view = 'main';
            break;
        case 'resetback':
            session.view = 'main';
            break;
        case 'save':
            await performSave(interaction, session, roleMap);
            break;
        case 'savecontinue':
            session.notice = '✅ Saved. Any further edits remain in the draft until you press **Save Changes** again.';
            session.view = 'main';
            break;
        case 'backmain':
            session.view = 'main';
            break;
        case 'cancel':
            setupSessions.delete(session.guildId);
            await interaction.editReply({
                content: '✅ Ping setup cancelled. No changes were saved. Run **/pingsetup** to start over.',
                embeds: [],
                components: [],
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            return true;
        case 'close':
            setupSessions.delete(session.guildId);
            await interaction.editReply({
                content: '✅ Ping setup closed.',
                embeds: [],
                components: [],
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            return true;
        default:
            return false;
    }
    await renderView(interaction, session, roleMap);
    return true;
}

/**
 * Validates every drafted role against the guild, drops invalid/deleted roles
 * (with warnings), and UPSERTs the complete config. The in-memory cache is
 * updated ONLY after the database write succeeds; a failure keeps the draft
 * and the session open and shows a truthful error.
 */
async function performSave(interaction, session, roleMap) {
    const warnings = [];
    const countries = {};
    const regions = {};

    for (const [code, roleId] of Object.entries(session.countryPings)) {
        const raw = String(roleId).trim();
        if (isRoleValid(roleMap, raw)) countries[code] = raw;
        else warnings.push(`${countryLabel(code)} → <@&${raw}>`);
    }
    for (const [code, roleId] of Object.entries(session.regionPings)) {
        const raw = String(roleId).trim();
        if (isRoleValid(roleMap, raw)) regions[code] = raw;
        else warnings.push(`${regionLabelSafe(code)} → <@&${raw}>`);
    }

    let saved;
    try {
        saved = await sharedPingDb.saveGuildPingSettings(interaction.guild.id, countries, regions);
    } catch (err) {
        session.lastError = sharedPingDb.sanitizeError(err);
        console.warn('[pingsetup] save failed — database row and cache untouched. Errors must be shown truthfully.', session.lastError);
        session.view = 'save_error';
        return;
    }

    session.countryPings = { ...saved.countryPings };
    session.regionPings = { ...saved.regionPings };
    session.lastSaved = { countryPings: { ...saved.countryPings }, regionPings: { ...saved.regionPings } };
    session.lastRemoveWarnings = warnings;
    session.lastError = null;
    session.dbStatus = { ok: true, configured: true };
    session.dbStatusAt = Date.now();
    session.view = 'save_success';
}

/* ================================================================== */
/* Slash command (/pingsetup)                                          */
/* ================================================================== */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pingsetup')
        .setDescription('Configure country/region raid-ping roles (Manage Server required).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    // Pure helpers exposed for unit tests:
    parsePingSetupCustomId,
    paginate,
    buildCountrySelectOptions,
    buildPayloadForView,
    isRoleValid,
    buildRoleMap,
    SESSION_TTL_MS,
    COUNTRY_PAGE_SIZE,
    VIEW_ALL_PAGE_SIZE,
    _getSession: (guildId) => setupSessions.get(String(guildId || '')),
    _stopSweeper: stopSweeper,

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.editReply({
                content: 'This command can only be used inside a server.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
        }
        if (!canManagePings(interaction)) {
            return interaction.editReply({
                content: '🔒 You need the **Manage Server** permission (Manage Guild or Administrator) to configure ping roles.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
        }

        // One active setup session per guild.
        sweepExpiredSessions();
        if (setupSessions.has(interaction.guild.id)) {
            const existing = setupSessions.get(interaction.guild.id);
            const minutesLeft = Math.max(1, Math.ceil((existing.expiresAt - Date.now()) / 60000));
            return interaction.editReply({
                content: '⚠️ A ping setup session is already active for this server. Only **one** session is allowed at a time — ' +
                    'the admin who opened it must press **Cancel / Close**, or it expires automatically in about ' +
                    `**${minutesLeft} min**.`,
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
        }

        const session = createSession(interaction);

        // Load the guild's existing config (saved via the old dashboard or a
        // previous /pingsetup save) into the DRAFT. This refresh also re-seeds
        // the in-memory cache, so old dashboard mappings appear automatically.
        const cfg = await sharedPingDb.refreshGuildSettingsCache(interaction.guild.id);
        session.countryPings = { ...(cfg.countryPings || {}) };
        session.regionPings = { ...(cfg.regionPings || {}) };
        await resolveDbStatus(session, true);

        const roles = await listGuildRoles(interaction.client, interaction.guild.id);
        const roleMap = buildRoleMap(roles);

        const payload = buildPayloadForView(session, roleMap);
        payload.flags = EPHEMERAL_FLAG;
        await interaction.editReply(payload).catch(() => null);
    }
};