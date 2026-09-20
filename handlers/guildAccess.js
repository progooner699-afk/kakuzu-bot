'use strict';
/* guildAccess.js — permanent premium server-access (Supabase authoritative,
   60s TTL cache speed-layer, fail-closed). Reuses sharedPingDb pool. */
// __PART2__
'use strict';

/**
 * guildAccess.js — permanent premium server-access system for Kakuzu.
 * Supabase (kakuzu_guilds + kakuzu_access_events) is authoritative; a 60s
 * TTL Map is a speed layer only and DB failures fail CLOSED (locked).
 * Reuses the shared pg Pool via sharedPingDb.runPoolQuery (no second pool).
 * Tables created idempotently; never DROP / TRUNCATE.
 * Password compared with crypto.timingSafeEqual, never logged/displayed.
 */

const crypto = require('crypto');
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionsBitField,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags,
} = require('discord.js');
const sharedPingDb = require('./sharedPingDb');
const { withTimeout } = require('./fetchTimeout');

const ACCESS_QUERY_TIMEOUT_MS = 8000;
const ACCESS_CACHE_TTL_MS = 60 * 1000;

const CREATE_GUILDS_SQL = [
'CREATE TABLE IF NOT EXISTS kakuzu_guilds (',
'    guild_id TEXT PRIMARY KEY,',
'    guild_name TEXT,',
'    owner_id TEXT,',
'    bot_present BOOLEAN NOT NULL DEFAULT TRUE,',
"    access_status TEXT NOT NULL DEFAULT 'pending'",
"        CHECK (access_status IN ('pending', 'granted', 'revoked')),",
'    onboarding_channel_id TEXT,',
'    onboarding_message_id TEXT,',
'    onboarding_created_at TIMESTAMPTZ,',
'    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
'    left_at TIMESTAMPTZ,',
'    granted_by TEXT,',
'    granted_at TIMESTAMPTZ,',
'    revoked_by TEXT,',
'    revoked_at TIMESTAMPTZ,',
'    owner_dm_status TEXT,',
'    owner_dm_sent_at TIMESTAMPTZ,',
'    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
')'].join('\n');

const CREATE_EVENTS_SQL = [
'CREATE TABLE IF NOT EXISTS kakuzu_access_events (',
'    id BIGSERIAL PRIMARY KEY,',
'    guild_id TEXT NOT NULL,',
'    action TEXT NOT NULL',
"        CHECK (action IN ('joined', 'granted', 'revoked', 'left')),",
'    performed_by TEXT,',
'    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
')'].join('\n');

let tablesReadyPromise = null;
async function ensureAccessTables() {
    if (tablesReadyPromise) return tablesReadyPromise;
    tablesReadyPromise = (async () => {
        if (!sharedPingDb.isDatabaseConfigured()) return false;
        try {
            await sharedPingDb.runPoolQuery(CREATE_GUILDS_SQL, [], ACCESS_QUERY_TIMEOUT_MS);
            await sharedPingDb.runPoolQuery(CREATE_EVENTS_SQL, [], ACCESS_QUERY_TIMEOUT_MS);
            await sharedPingDb.runPoolQuery('CREATE INDEX IF NOT EXISTS idx_kakuzu_guilds_access_status ON kakuzu_guilds (access_status)', [], ACCESS_QUERY_TIMEOUT_MS);
            await sharedPingDb.runPoolQuery('CREATE INDEX IF NOT EXISTS idx_kakuzu_access_events_guild_id ON kakuzu_access_events (guild_id)', [], ACCESS_QUERY_TIMEOUT_MS);
            return true;
        } catch (err) {
            console.warn('[guildAccess] table init failed (will retry lazily):', sharedPingDb.sanitizeError(err));
            tablesReadyPromise = null;
            return false;
        }
    })();
    return tablesReadyPromise;
}
function getSupportGuildId() { return String(process.env.SUPPORT_GUILD_ID || '1536031049774010408').trim(); }
function getBotOwnerId() { return String(process.env.BOT_OWNER_ID || '').trim(); }
/* Super-admin bypass: this Discord user can ALWAYS manage access (grant/revoke/
   status) from ANY server with NO password. Covers env misconfig (missing
   BOT_OWNER_ID / SUPPORT_GUILD_ID / password) which is why owners see
   "Access denied" even with the right account. */
const SUPERADMIN_USER_IDS = String(process.env.SUPERADMIN_IDS || '1392856295807389756')
    .split(',').map((s) => s.trim()).filter(Boolean);
const SUPERADMIN_USERNAMES = ['yourdad043'];
function getSuperAdminIds() { return [...SUPERADMIN_USER_IDS]; }
function normalizeName(s) { return String(s || '').trim().toLowerCase(); }
function isSuperAdmin(memberOrUser) {
    try {
        const m = memberOrUser || {};
        const user = (m.user && typeof m.user === 'object') ? m.user : m;
        const id = String(m.id || user.id || '').trim();
        if (id && SUPERADMIN_USER_IDS.some((sid) => String(sid) === id)) return true;
        const names = [
            user.username, user.globalName, user.displayName,
            m.username, m.displayName, m.nickname,
        ].map(normalizeName).filter(Boolean);
        return names.some((n) => SUPERADMIN_USERNAMES.includes(n));
    } catch (_) { return false; }
}
function getSupabaseDashboardUrl() { return String(process.env.SUPABASE_DASHBOARD_URL || '').trim(); }
function getSupportUrl() { return String(process.env.KAKUZU_SUPPORT_URL || 'https://discord.gg/6zWMf3s9BD').trim(); }
function getManagerRoleIds() {
    return String(process.env.ACCESS_MANAGER_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function verifyAccessPassword(candidate) {
    const expected = String(process.env.ACCESS_GRANT_PASSWORD || '');
    const given = String(candidate || '');
    if (!expected || !given) return false;
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) { try { crypto.timingSafeEqual(a, a); } catch (_) {} return false; }
    try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}
function authorizeAccessManager(member, guildId, password) {
    // 0) Super-admin: always allowed, any server, no password.
    try { if (isSuperAdmin(member)) return { ok: true, reason: 'ok' }; } catch (_) {}
    const userId = member && (member.id || (member.user && member.user.id));
    const ownerId = getBotOwnerId();
    // Owner fallback: if BOT_OWNER_ID is unset on the host, fall back to the
    // Discord application owner id when the caller provides it.
    let effectiveOwnerId = ownerId;
    try {
        if (!effectiveOwnerId && member && member.client && member.client.application) {
            const app = member.client.application;
            const appOwner = (app.owner && (app.owner.id || (app.owner.user && app.owner.user.id))) || null;
            if (appOwner) effectiveOwnerId = String(appOwner);
        }
    } catch (_) {}
    const isOwner = Boolean(effectiveOwnerId && userId && String(userId) === String(effectiveOwnerId));
    // 1) Bot owner: allowed from ANY server (fixes "Access denied" when the
    // owner runs the command outside the support server). Still needs password
    // unless they are also the super-admin above.
    if (isOwner) {
        if (!String(process.env.ACCESS_GRANT_PASSWORD || '')) {
            return { ok: false, reason: 'ACCESS_GRANT_PASSWORD is not configured on the host. Set it in Render env vars.' };
        }
        if (!verifyAccessPassword(password)) return { ok: false, reason: 'Incorrect access password.' };
        return { ok: true, reason: 'ok' };
    }
    const supportGuildId = getSupportGuildId();
    if (!supportGuildId || String(guildId || '') !== supportGuildId) {
        return { ok: false, reason: 'This command can only be used inside the Kakuzu Support Server.' };
    }
    let hasRole = false;
    try {
        const wanted = new Set(getManagerRoleIds());
        const held = (member && member.roles && member.roles.cache) ? [...member.roles.cache.keys()].map(String) : [];
        hasRole = held.some((id) => wanted.has(String(id)));
    } catch (_) { hasRole = false; }
    if (!hasRole) return { ok: false, reason: 'You are not authorized to manage Kakuzu server access.' };
    if (!verifyAccessPassword(password)) return { ok: false, reason: 'Incorrect access password.' };
    return { ok: true, reason: 'ok' };
}
const accessCache = new Map();
function getCachedStatus(gid) {
    const e = accessCache.get(String(gid || ''));
    if (!e) return null;
    if (Date.now() > e.expiresAt) { accessCache.delete(String(gid || '')); return null; }
    return e.status;
}
function setCachedStatus(gid, status) {
    if (!status) return;
    accessCache.set(String(gid || ''), { status: String(status), expiresAt: Date.now() + ACCESS_CACHE_TTL_MS });
}
function invalidateGuildCache(gid) { accessCache.delete(String(gid || '')); }
function getAccessCacheSize() { return accessCache.size; }
function mapRow(row) {
    if (!row) return null;
    return { guildId: row.guild_id, guildName: row.guild_name, ownerId: row.owner_id,
        botPresent: row.bot_present, accessStatus: row.access_status,
        onboardingChannelId: row.onboarding_channel_id, onboardingMessageId: row.onboarding_message_id,
        onboardingCreatedAt: row.onboarding_created_at, joinedAt: row.joined_at, leftAt: row.left_at,
        grantedBy: row.granted_by, grantedAt: row.granted_at, revokedBy: row.revoked_by, revokedAt: row.revoked_at,
        ownerDmStatus: row.owner_dm_status, ownerDmSentAt: row.owner_dm_sent_at, updatedAt: row.updated_at };
}
async function recordAccessEvent(gid, action, by) {
    try {
        await ensureAccessTables();
        await sharedPingDb.runPoolQuery('INSERT INTO kakuzu_access_events (guild_id, action, performed_by) VALUES ($1, $2, $3)',
            [String(gid), String(action), by ? String(by) : null], ACCESS_QUERY_TIMEOUT_MS);
    } catch (err) { console.warn('[guildAccess] audit insert failed:', sharedPingDb.sanitizeError(err)); }
}
async function fetchGuildRow(gid) {
    await ensureAccessTables();
    const r = await sharedPingDb.runPoolQuery('SELECT * FROM kakuzu_guilds WHERE guild_id = $1', [String(gid)], ACCESS_QUERY_TIMEOUT_MS);
    if (!r || !r.rows || r.rows.length === 0) return null;
    return mapRow(r.rows[0]);
}
async function getGuildAccessStatus(gidRaw) {
    const gid = String(gidRaw || '').trim();
    if (!gid) return 'pending';
    const cached = getCachedStatus(gid);
    if (cached) return cached;
    try {
        const row = await withTimeout(fetchGuildRow(gid), ACCESS_QUERY_TIMEOUT_MS, 'guild access read');
        const s = row && row.accessStatus;
        const safe = s === 'granted' ? 'granted' : s === 'revoked' ? 'revoked' : 'pending';
        setCachedStatus(gid, safe);
        return safe;
    } catch (err) {
        console.warn('[guildAccess] status read failed (fail-closed):', sharedPingDb.sanitizeError(err));
        return 'pending';
    }
}
async function isGuildGranted(gid) { return (await getGuildAccessStatus(gid)) === 'granted'; }

async function upsertGuildOnJoin(info) {
    const gid = String(info.guildId || '').trim();
    if (!gid) throw new Error('guildId is required.');
    await ensureAccessTables();
    const sql = 'INSERT INTO kakuzu_guilds (guild_id, guild_name, owner_id, bot_present, left_at, updated_at) VALUES ($1, $2, $3, TRUE, NULL, NOW()) ON CONFLICT (guild_id) DO UPDATE SET guild_name = EXCLUDED.guild_name, owner_id = EXCLUDED.owner_id, bot_present = TRUE, left_at = NULL, updated_at = NOW() RETURNING *';
    const r = await sharedPingDb.runPoolQuery(sql,
        [gid, info.guildName ? String(info.guildName) : null, info.ownerId ? String(info.ownerId) : null], ACCESS_QUERY_TIMEOUT_MS);
    const row = r && r.rows && r.rows[0] ? mapRow(r.rows[0]) : null;
    if (row && row.accessStatus) setCachedStatus(gid, row.accessStatus);
    return row;
}
async function markGuildLeft(gidRaw) {
    const gid = String(gidRaw || '').trim();
    if (!gid) return null;
    await ensureAccessTables();
    const r = await sharedPingDb.runPoolQuery('UPDATE kakuzu_guilds SET bot_present = FALSE, left_at = NOW(), updated_at = NOW() WHERE guild_id = $1 RETURNING *',
        [gid], ACCESS_QUERY_TIMEOUT_MS).catch((e) => { console.warn('[guildAccess] mark-left failed:', sharedPingDb.sanitizeError(e)); return null; });
    invalidateGuildCache(gid);
    const row = r && r.rows && r.rows[0] ? mapRow(r.rows[0]) : null;
    if (row && row.accessStatus) setCachedStatus(gid, row.accessStatus);
    await recordAccessEvent(gid, 'left', null);
    return row;
}
async function saveOnboardingRefs(gidRaw, chId, msgId) {
    await ensureAccessTables();
    await sharedPingDb.runPoolQuery('UPDATE kakuzu_guilds SET onboarding_channel_id = $2, onboarding_message_id = $3, onboarding_created_at = COALESCE(onboarding_created_at, NOW()), updated_at = NOW() WHERE guild_id = $1',
        [String(gidRaw), chId ? String(chId) : null, msgId ? String(msgId) : null], ACCESS_QUERY_TIMEOUT_MS)
        .catch((e) => console.warn('[guildAccess] onboarding ref save failed:', sharedPingDb.sanitizeError(e)));
}
async function saveOwnerDmStatus(gidRaw, status) {
    await ensureAccessTables();
    await sharedPingDb.runPoolQuery('UPDATE kakuzu_guilds SET owner_dm_status = $2, owner_dm_sent_at = NOW(), updated_at = NOW() WHERE guild_id = $1',
        [String(gidRaw), status ? String(status) : null], ACCESS_QUERY_TIMEOUT_MS)
        .catch((e) => console.warn('[guildAccess] owner DM status save failed:', sharedPingDb.sanitizeError(e)));
}


async function grantGuildAccess(gidRaw, modId) {
    const gid = String(gidRaw || '').trim();
    await ensureAccessTables();
    const existing = await fetchGuildRow(gid);
    if (existing && existing.accessStatus === 'granted') { setCachedStatus(gid, 'granted'); return { row: existing, alreadyGranted: true }; }
    const r = await sharedPingDb.runPoolQuery("UPDATE kakuzu_guilds SET access_status = 'granted', granted_by = $2, granted_at = NOW(), revoked_by = NULL, revoked_at = NULL, updated_at = NOW() WHERE guild_id = $1 RETURNING *",
        [gid, String(modId)], ACCESS_QUERY_TIMEOUT_MS);
    if (!r || !r.rows || r.rows.length === 0) throw new Error('Target server has no access record. Ask the owner to re-invite Kakuzu, then try again.');
    const row = mapRow(r.rows[0]);
    setCachedStatus(gid, 'granted');
    await recordAccessEvent(gid, 'granted', String(modId));
    return { row, alreadyGranted: false };
}
async function revokeGuildAccess(gidRaw, modId) {
    const gid = String(gidRaw || '').trim();
    await ensureAccessTables();
    const r = await sharedPingDb.runPoolQuery("UPDATE kakuzu_guilds SET access_status = 'revoked', revoked_by = $2, revoked_at = NOW(), updated_at = NOW() WHERE guild_id = $1 RETURNING *",
        [gid, String(modId)], ACCESS_QUERY_TIMEOUT_MS);
    if (!r || !r.rows || r.rows.length === 0) throw new Error('Target server has no access record. Nothing was changed.');
    const row = mapRow(r.rows[0]);
    setCachedStatus(gid, 'revoked');
    await recordAccessEvent(gid, 'revoked', String(modId));
    return row;
}

function supabaseField() {
    const url = getSupabaseDashboardUrl();
    if (!url) return null;
    return { name: 'Supabase project', value: url, inline: false };
}

function filterFields(...fields) { return fields.filter((f) => f != null); }

const PENDING_COLOR = 0xE74C3C;
const GRANTED_COLOR = 0x2ECC71;
const REVOKED_COLOR = 0xE67E22;
const ONBOARDING_CHANNEL_NAME = 'kakuzu-access';
const ONBOARDING_REASON = 'Kakuzu premium access information';
function supportLinkRow() {
    const url = getSupportUrl();
    if (!url) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Kakuzu Support').setURL(url));
}
function buildPendingEmbed(o) {
    const url = getSupportUrl();
    const supportId = getSupportGuildId();
    const stepsQ = [
        '> **1. Join the Kakuzu Support Server**' + (url ? ' -- ' + url : ''),
        '> **2. Open a ticket** (ticket / support channel) in the support server.',
        '> **3. Send the moderator your Server ID** (see the copy-paste box below).',
        '> **4. A Kakuzu moderator runs /accessgrant** for your server.',
        '> **5. Come back here** -- commands unlock automatically once granted.',
    ];
    const steps = stepsQ.join(NL);
    const e = new EmbedBuilder()
        .setTitle('🔒 Kakuzu Premium Access Required')
        .setDescription('Kakuzu is a **private premium bot**. This server has not been authorized yet, so every command and feature is currently locked.' + NL2 +
            'Nothing is broken — your server simply needs access granted **once** by a Kakuzu moderator.')
        .addFields(filterFields(
            { name: '🎟️ How to get access', value: steps },
            { name: '📌 Server information', value: 'Server: ' + (o.guildName || 'Unknown') + NL + 'Server ID: `' + o.guildId + '`' + NL + 'Owner: <@' + (o.ownerId || 'unknown') + '>' },
            { name: '🆘 Support server', value: (url ? url + NL : '') + (supportId ? 'Support Server ID: `' + supportId + '`' : 'Ask a Kakuzu moderator for an invite.') },
            { name: '⚡ Important', value: 'Access is granted once per server and survives bot updates and redeployments.' + NL + '**Never share the Kakuzu access password with anyone.**' },
            supabaseField()))
        .setColor(PENDING_COLOR)
        .setFooter({ text: 'Kakuzu • Premium Server Access' })
        .setTimestamp();
    const row = supportLinkRow();
    return { embeds: [e], components: row ? [row] : [] };
}
function buildGrantedEmbed(o) {
    const unix = o.grantedAt ? Math.floor(new Date(o.grantedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const e = new EmbedBuilder()
        .setTitle('✅ Kakuzu Access Granted')
        .setDescription('This server has been authorized to use Kakuzu. All available commands and features are now unlocked.')
        .addFields(filterFields({ name: 'Server', value: (o.guildName || 'Unknown') + '\n`' + o.guildId + '`' },
            { name: 'Access granted', value: '<t:' + unix + ':F>' },
            { name: 'Getting started', value: 'You can now use Kakuzu\u2019s slash commands in this server.' },
            supabaseField()))
        .setColor(GRANTED_COLOR)
        .setFooter({ text: 'Kakuzu • Premium Access Active' })
        .setTimestamp();
    return { embeds: [e], components: [] };
}
function buildRevokedEmbed(o) {
    const e = new EmbedBuilder()
        .setTitle('🔒 Kakuzu Access Revoked')
        .setDescription('Kakuzu access for this server has been revoked, so its commands and features are currently locked.\n\nJoin the Kakuzu Support Server, create a ticket and ask a moderator to review access for your server.')
        .addFields(filterFields(
            { name: 'Server information', value: 'Server: ' + (o.guildName || 'Unknown') + '\nServer ID: ' + o.guildId },
            { name: 'Important', value: 'Give the Server ID shown above to the support moderator.' },
            supabaseField()))
        .setColor(REVOKED_COLOR)
        .setFooter({ text: 'Kakuzu • Premium Server Access' })
        .setTimestamp();
    const row = supportLinkRow();
    return { embeds: [e], components: row ? [row] : [] };
}
/* ------------------------------------------------------------------ *
 * Components V2 access card (the kakuzu-access channel message)
 * ------------------------------------------------------------------ *
 * The message in `kakuzu-access` is a NATIVE Components V2 card: a Container
 * (type 17) with an accent colour bar, TextDisplay (type 10) sections split by
 * native Separator (type 14) dividers, quote-bar (`> `) detail rows, and a
 * Link button to the Kakuzu Support Server. Components V2 DISABLES the classic
 * embed on the same message, so every edit of a V2 card MUST keep passing
 * ACCESS_V2_FLAGS. Components V2 is a gated Discord feature: if Discord rejects
 * the V2 payload, callers fall back to the classic embed builders above.
 */
const ACCESS_V2_FLAGS = 1 << 15;                       // MessageFlags.IsComponentsV2
const NL = String.fromCharCode(10);
const NL2 = NL + NL;
const ACCESS_CARD_KINDS = ['pending', 'granted', 'revoked'];

function v2Text(content) { return new TextDisplayBuilder().setContent(content).toJSON(); }
function v2Separator() {
    // divider:true is what actually draws the horizontal line (type 14).
    return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small).toJSON();
}
function supportButtonRow() {
    const url = getSupportUrl();
    if (!url) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Kakuzu Support Server').setURL(url));
}
/** Quote-bar'd support-server details, reused by every card. */
function supportServerQuoteLines() {
    const url = getSupportUrl();
    const id = getSupportGuildId();
    return [
        '> **Support Server:** ' + (url ? url : 'Ask a Kakuzu moderator for an invite.'),
        '> **Support Server ID:** `' + (id || 'unset') + '`'
    ].join(NL);
}

function pendingCardSections(o) {
    const gid = String(o.guildId || 'unknown');
    const gname = o.guildName || 'Unknown';
    const owner = o.ownerId ? '<@' + o.ownerId + '>' : 'Unknown';
    return [
        '### 🔒 KAKUZU PREMIUM ACCESS REQUIRED' + NL +
        '> **Server:** ' + gname + NL +
        '> **Server ID:** `' + gid + '`' + NL +
        '> **Owner:** ' + owner + NL +
        '> **Status:** `🔴 NOT GRANTED`',

        '### 📋 WHAT IS THIS?' + NL2 +
        'Kakuzu is a **private premium bot**. This server has not been authorized yet, so every slash command, button and feature is currently **locked**.' + NL2 +
        'Nothing is broken — your server simply needs access granted once by a Kakuzu moderator.',

        '### 🎟️ HOW TO GET ACCESS' + NL2 +
        '> **Step 1** — Join the Kakuzu Support Server (link below, button at the bottom).' + NL +
        '> **Step 2** — Open a **ticket** in the support server.' + NL +
        '> **Step 3** — Copy the **Server ID** shown above and send it to the moderator.' + NL +
        '> **Step 4** — A Kakuzu moderator reviews the request and grants access.' + NL +
        '> **Step 5** — Kakuzu unlocks **automatically** — you never need to re-invite the bot.',

        '### 📌 WHERE TO SEND YOUR REQUEST' + NL2 +
        supportServerQuoteLines() + NL +
        '> **Server Name:** ' + gname + NL +
        '> **Server ID:** `' + gid + '`' + NL +
        '> **Ticket Contact:** ' + owner,

        '### ✨ HOW TO FIND YOUR SERVER ID' + NL2 +
        '> Open **User Settings** → **Advanced** → enable **Developer Mode**.' + NL +
        '> Right-click your server icon → **Copy Server ID**.' + NL +
        '> Paste that ID into your support ticket.',

        '### ⚡ IMPORTANT' + NL2 +
        '> Access is granted **once** per server and is **permanent** — it survives bot updates and redeployments.' + NL +
        '> Only authorized Kakuzu staff can grant or revoke access.' + NL +
        '> **Never share the Kakuzu access password with anyone.**'
    ];
}

function grantedCardSections(o) {
    const gid = String(o.guildId || 'unknown');
    const gname = o.guildName || 'Unknown';
    const unix = o.grantedAt ? Math.floor(new Date(o.grantedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const byLine = o.grantedBy ? '<@' + o.grantedBy + '>' : 'A Kakuzu moderator';
    return [
        '### ✅ KAKUZU ACCESS GRANTED' + NL +
        '> **Server:** ' + gname + NL +
        '> **Server ID:** `' + gid + '`' + NL +
        '> **Status:** `🟢 GRANTED`' + NL +
        '> **Granted:** <t:' + unix + ':F>' + NL +
        '> **Granted By:** ' + byLine,

        '### 🚀 YOU ARE ALL SET' + NL2 +
        'Every Kakuzu command and feature is now **unlocked** in this server. No further action is required.',

        '### 📌 NEXT STEPS' + NL2 +
        '> Run `/backuppanel` to post the Roblox linking panel.' + NL +
        '> Ask your raiders to link their Roblox account before requesting help.' + NL +
        '> Run `/setchannels` to choose the raid-result channel.' + NL +
        '> Run `/pingsetup` to map country / region ping roles.',

        '### ℹ️ GOOD TO KNOW' + NL2 +
        '> Access stays active across bot updates and redeployments.' + NL +
        '> **Never share the Kakuzu access password with anyone.**' + NL +
        supportServerQuoteLines()
    ];
}

function revokedCardSections(o) {
    const gid = String(o.guildId || 'unknown');
    const gname = o.guildName || 'Unknown';
    const unix = o.revokedAt ? Math.floor(new Date(o.revokedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
    return [
        '### 🔒 KAKUZU ACCESS REVOKED' + NL +
        '> **Server:** ' + gname + NL +
        '> **Server ID:** `' + gid + '`' + NL +
        '> **Status:** `🟠 REVOKED`' + NL +
        '> **Revoked:** <t:' + unix + ':F>',

        '### 📋 WHAT HAPPENED?' + NL2 +
        'Access for this server has been **revoked**, so Kakuzu\u2019s commands and features are locked again.',

        '### 🎟️ HOW TO RESTORE ACCESS' + NL2 +
        '> **Step 1** — Join the Kakuzu Support Server (link below, button at the bottom).' + NL +
        '> **Step 2** — Create a ticket explaining that your access needs to be reviewed.' + NL +
        '> **Step 3** — Send the **Server ID** shown above to the moderator.' + NL +
        '> **Step 4** — A moderator re-enables access for your server.' + NL +
        '> **Step 5** — Kakuzu unlocks **automatically**.',

        '### 📌 WHERE TO SEND YOUR REQUEST' + NL2 +
        supportServerQuoteLines()
    ];
}

function cardSectionsFor(kind, o) {
    if (kind === 'granted') return grantedCardSections(o);
    if (kind === 'revoked') return revokedCardSections(o);
    return pendingCardSections(o);
}

function accentFor(kind) {
    if (kind === 'granted') return GRANTED_COLOR;
    if (kind === 'revoked') return REVOKED_COLOR;
    return PENDING_COLOR;
}

/**
 * Native Components V2 access card (Container + TextDisplays + Separators +
 * Link button). Returns null when Components V2 is unusable so callers can fall
 * back to the classic embed builders.
 */
function buildAccessV2Payload(kind, o) {
    const data = o || {};
    const content = [];
    // Every section is followed by a native Separator (type 14) so the button
    // row below is always preceded by one too — matching the raid alert layout.
    cardSectionsFor(kind, data).forEach((body) => { content.push(v2Text(body)); content.push(v2Separator()); });
    const container = new ContainerBuilder().setAccentColor(accentFor(kind)).toJSON();
    container.size = 'large';
    container.components = content;
    const row = supportButtonRow();
    if (row) container.components.push(row.toJSON());
    return { flags: ACCESS_V2_FLAGS, components: [container] };
}

/** Classic-embed fallback for the same card (no V2 support / V2 rejected). */
function buildAccessEmbedPayload(kind, o) {
    if (kind === 'granted') return buildGrantedEmbed(o || {});
    if (kind === 'revoked') return buildRevokedEmbed(o || {});
    return buildPendingEmbed(o || {});
}

function buildOwnerDmPayload(o) {
    const e = new EmbedBuilder()
        .setTitle('✅ Your Server Has Kakuzu Access')
        .setDescription('Your server **' + (o.guildName || 'Unknown') + '** has been granted access to Kakuzu. You can now use Kakuzu\u2019s commands and features in that server.')
        .addFields(filterFields(
            { name: 'Server ID', value: String(o.guildId) },
            { name: 'Access granted by', value: o.moderatorMention || 'A Kakuzu moderator' },
            supabaseField()))
        .setColor(GRANTED_COLOR)
        .setFooter({ text: 'Kakuzu Premium Access Active' })
        .setTimestamp();
    const dmRow = supportLinkRow();
    return { embeds: [e], components: dmRow ? [dmRow] : [] };
}
function buildLockedReply() {
    const row = supportLinkRow();
    const lockEmoji = String.fromCodePoint(0x1F512);
    return { content: lockEmoji + ' This server has not been granted access to Kakuzu. Join the Kakuzu Support Server and create a ticket to request access.',
        components: row ? [row] : [], flags: 64 };
}
function buildMissingPermsDm(o) {
    const e = new EmbedBuilder()
        .setTitle('🔒 Kakuzu Needs Permission to Join Your Server')
        .setDescription('Kakuzu is currently locked out of your server because it needs the **Manage Channels** permission to create its access-information channel (`' + ONBOARDING_CHANNEL_NAME + '`). Without this permission, Kakuzu cannot create the channel it needs to show the premium access status, so the bot is effectively locked in your server.')
        .addFields(
            { name: 'What to do', value: '1. Go to your server **Settings** → **Roles**.\n2. Select the role assigned to the Kakuzu bot.\n3. Enable **Manage Channels**.\n4. Wait a few seconds — Kakuzu will automatically create the `' + ONBOARDING_CHANNEL_NAME + '` channel.' },
            { name: 'Why this is needed', value: 'Kakuzu creates a `' + ONBOARDING_CHANNEL_NAME + '` channel in every server it joins to display the premium access status. Without **Manage Channels**, it cannot create this channel and therefore cannot function in your server.' },
            { name: 'Server information', value: 'Server: ' + (o.guildName || 'Unknown') + '\nServer ID: ' + o.guildId + '\nOwner: <@' + (o.ownerId || 'unknown') + '>' }
        )
        .setColor(PENDING_COLOR)
        .setFooter({ text: 'Kakuzu • Premium Server Access' })
        .setTimestamp();
    return { embeds: [e] };
}

function botHasOnboardingPerms(me) {
    try {
        if (!me || !me.permissions) return false;
        const p = me.permissions;
        return p.has(PermissionsBitField.Flags.ManageChannels) && p.has(PermissionsBitField.Flags.ViewChannel)
            && p.has(PermissionsBitField.Flags.SendMessages) && p.has(PermissionsBitField.Flags.EmbedLinks);
    } catch (_) { return false; }
}
function botMissingManageChannels(me) {
    try {
        if (!me || !me.permissions) return true;
        return !me.permissions.has(PermissionsBitField.Flags.ManageChannels);
    } catch (_) { return true; }
}
async function resolveExistingOnboardingChannel(client, guild, storedId) {
    if (storedId) {
        try {
            const ch = await client.channels.fetch(String(storedId)).catch(() => null);
            if (ch && ch.guildId === guild.id && ch.isTextBased && ch.isTextBased()) return ch;
        } catch (_) {}
    }
    try {
        const found = guild.channels.cache.find((c) => c && c.name === ONBOARDING_CHANNEL_NAME && c.type === ChannelType.GuildText);
        if (found) return found;
        const fetched = await guild.channels.fetch().catch(() => null);
        if (fetched) {
            const m = fetched.find((c) => c && c.name === ONBOARDING_CHANNEL_NAME && c.type === ChannelType.GuildText);
            if (m) return m;
        }
    } catch (_) {}
    return null;
}
/**
 * True when a message is one of OUR access cards. Handles BOTH formats: the
 * classic embed card AND the native Components V2 card (V2 messages carry no
 * embed and no content, so the TextDisplays must be scanned instead). Used to
 * avoid ever posting a second `kakuzu-access` card.
 */
function isKakuzuAccessMessage(msg, client) {
    try {
        if (!msg || !msg.author || !client || !client.user || msg.author.id !== client.user.id) return false;
        if (Array.isArray(msg.embeds) && msg.embeds.some((e) => ((e && e.title) || '').includes('Kakuzu'))) return true;
        const raw = JSON.stringify(msg.components || []);
        return /KAKUZU (PREMIUM ACCESS REQUIRED|ACCESS GRANTED|ACCESS REVOKED)/.test(raw);
    } catch (_) { return false; }
}
/** True when a message was posted with the native Components V2 flag. */
function messageIsComponentsV2(msg) {
    try {
        const flags = msg && msg.flags;
        if (flags == null) return false;
        if (typeof flags.has === 'function') {
            const bit = (MessageFlags && MessageFlags.IsComponentsV2 != null) ? MessageFlags.IsComponentsV2 : ACCESS_V2_FLAGS;
            return flags.has(bit);
        }
        const n = Number(flags);
        return Number.isFinite(n) && (n & ACCESS_V2_FLAGS) !== 0;
    } catch (_) { return false; }
}
async function ensureOnboardingForLockedGuild(client, guild, stored) {
    const gid = guild.id;
    let ownerId = (stored && stored.ownerId) || null;
    try { const o = await guild.fetchOwner(); if (o && o.id) ownerId = o.id; } catch (_) {}
    const existing = await resolveExistingOnboardingChannel(client, guild, stored && stored.onboardingChannelId);
    const cardData = { guildName: guild.name, guildId: gid, ownerId };
    const payload = buildPendingEmbed(cardData);
    // Prefer the native Components V2 card (Container + Separators + quote
    // bars). V2 is a gated Discord feature, so if the send is rejected fall back
    // to the classic embed — onboarding must never fail to post.
    const sendCard = async (channel) => {
        try {
            return await channel.send(buildAccessV2Payload('pending', cardData));
        } catch (e) {
            console.warn('[guildAccess] V2 access card rejected — using embed fallback:', (e && e.message) || e);
            return channel.send(payload);
        }
    };
    if (existing) {
        if (stored && stored.onboardingMessageId) {
            try {
                const msg = await existing.messages.fetch(String(stored.onboardingMessageId)).catch(() => null);
                if (msg) return { channelId: existing.id, messageId: msg.id, created: false };
            } catch (_) {}
        } else {
            try {
                const recent = await existing.messages.fetch({ limit: 20 }).catch(() => null);
                if (recent) {
                    const mine = recent.find((m) => isKakuzuAccessMessage(m, client));
                    if (mine) { await saveOnboardingRefs(gid, existing.id, mine.id); return { channelId: existing.id, messageId: mine.id, created: false }; }
                }
            } catch (_) {}
        }
        try {
            const sent = await sendCard(existing);
            await saveOnboardingRefs(gid, existing.id, sent.id);
            return { channelId: existing.id, messageId: sent.id, created: true };
        } catch (e) {
            console.warn('[guildAccess] onboarding send failed:', (e && e.message) || e);
            await saveOnboardingRefs(gid, existing.id, (stored && stored.onboardingMessageId) || null);
            return { channelId: existing.id, messageId: null, created: false, error: (e && e.message) || String(e) };
        }
    }
    const me = guild.members && guild.members.me ? guild.members.me : null;
    if (!me || botHasOnboardingPerms(me)) {
        try {
            const created = await guild.channels.create({ name: ONBOARDING_CHANNEL_NAME, type: ChannelType.GuildText,
                reason: ONBOARDING_REASON, topic: 'Kakuzu premium access information. Commands stay locked until access is granted.' });
            const sent = await sendCard(created);
            await saveOnboardingRefs(gid, created.id, sent.id);
            return { channelId: created.id, messageId: sent.id, created: true };
        } catch (e) { console.warn('[guildAccess] channel create failed:', (e && e.message) || e); }
    } else {
        console.warn('[guildAccess] missing channel perms in guild ' + gid + ' — trying fallbacks.');
    }
    try {
        if (guild.systemChannel && guild.systemChannel.isTextBased && guild.systemChannel.isTextBased()) {
            const sent = await sendCard(guild.systemChannel);
            await saveOnboardingRefs(gid, guild.systemChannel.id, sent.id);
            return { channelId: guild.systemChannel.id, messageId: sent.id, created: true, fallback: 'system-channel' };
        }
    } catch (e) { console.warn('[guildAccess] system-channel fallback failed:', (e && e.message) || e); }
    try {
        const ownerUser = ownerId ? await client.users.fetch(String(ownerId)).catch(() => null) : null;
        if (ownerUser) {
            const sent = await ownerUser.send(payload);
            await saveOnboardingRefs(gid, null, sent.id);
            return { channelId: null, messageId: sent.id, created: true, fallback: 'owner-dm' };
        }
    } catch (e) { console.warn('[guildAccess] owner-DM fallback failed:', (e && e.message) || e); }
    // If ManageChannels is missing, DM the owner with a specific explanation.
    if (botMissingManageChannels(me)) {
        try {
            const missingPermsOwner = ownerId ? await client.users.fetch(String(ownerId)).catch(() => null) : null;
            if (missingPermsOwner) {
                await missingPermsOwner.send(buildMissingPermsDm({ guildName: guild.name, guildId: gid, ownerId })).catch(() => null);
            }
        } catch (e) { console.warn('[guildAccess] missing-perms DM failed:', (e && e.message) || e); }
    }
    await saveOnboardingRefs(gid, (stored && stored.onboardingChannelId) || null, (stored && stored.onboardingMessageId) || null);
    return { channelId: null, messageId: null, created: false, error: 'No writable channel or DM available.' };
}
/**
 * Rewrites the `kakuzu-access` card in place.
 *
 * Two call styles are supported:
 *   editOnboardingMessage(client, gid, 'granted', { grantedAt, grantedBy })
 *   editOnboardingMessage(client, gid, (stored) => classicEmbedPayload)   // legacy
 *
 * The card's EXISTING format is detected from the message flags, so a V2 card
 * is edited as V2 (Container + Separators, keeping ACCESS_V2_FLAGS) and an embed
 * card is edited as an embed. Mixing the two is rejected by Discord, which is
 * exactly why the format must be preserved on every edit.
 */
async function editOnboardingMessage(client, gid, kindOrBuilder, data) {
    const legacyBuilder = typeof kindOrBuilder === 'function' ? kindOrBuilder : null;
    const kind = ACCESS_CARD_KINDS.indexOf(String(kindOrBuilder)) !== -1 ? String(kindOrBuilder) : 'pending';
    try {
        const stored = await fetchGuildRow(gid).catch(() => null);
        const merged = Object.assign({ guildId: String(gid) }, (stored || {}), (data || {}));
        const payloadFor = (isV2) => (legacyBuilder
            ? legacyBuilder(stored || {})
            : (isV2 ? buildAccessV2Payload(kind, merged) : buildAccessEmbedPayload(kind, merged)));
        if (stored && stored.onboardingChannelId && stored.onboardingMessageId) {
            try {
                const ch = await client.channels.fetch(String(stored.onboardingChannelId)).catch(() => null);
                if (ch && ch.isTextBased && ch.isTextBased()) {
                    const msg = await ch.messages.fetch(String(stored.onboardingMessageId)).catch(() => null);
                    if (msg) {
                        const isV2 = messageIsComponentsV2(msg);
                        await msg.edit(payloadFor(isV2));
                        return { edited: true, channelId: ch.id, messageId: msg.id, format: isV2 ? 'v2' : 'embed' };
                    }
                }
            } catch (e) { console.warn('[guildAccess] onboarding edit failed:', (e && e.message) || e); }
        }
        try {
            const guild = await client.guilds.fetch(String(gid)).catch(() => null);
            if (!guild) return { edited: false };
            const existing = await resolveExistingOnboardingChannel(client, guild, stored && stored.onboardingChannelId);
            if (existing) {
                // No known message id -> post a fresh card (V2 first, embed fallback).
                let sent = null;
                if (legacyBuilder) {
                    sent = await existing.send(legacyBuilder(stored || {})).catch(() => null);
                } else {
                    try { sent = await existing.send(buildAccessV2Payload(kind, merged)); }
                    catch (e) {
                        console.warn('[guildAccess] V2 access card rejected on recreate — using embed:', (e && e.message) || e);
                        sent = await existing.send(buildAccessEmbedPayload(kind, merged)).catch(() => null);
                    }
                }
                if (sent) { await saveOnboardingRefs(gid, existing.id, sent.id); return { edited: false, recreated: true, channelId: existing.id, messageId: sent.id }; }
            }
        } catch (_) {}
        return { edited: false };
    } catch (e) { console.warn('[guildAccess] editOnboarding failed:', (e && e.message) || e); return { edited: false }; }
}
async function handleGuildJoin(client, guild, registerFn) {
    const gid = guild.id;
    let ownerId = null;
    try { const o = await guild.fetchOwner(); if (o && o.id) ownerId = o.id; } catch (_) {}
    let row = null;
    try { row = await upsertGuildOnJoin({ guildId: gid, guildName: guild.name, ownerId }); }
    catch (e) { console.warn('[guildAccess] join upsert failed:', sharedPingDb.sanitizeError(e)); }
    await recordAccessEvent(gid, 'joined', null);
    if (typeof registerFn === 'function') {
        try { await registerFn(gid); console.log('Joined "' + guild.name + '" (' + gid + ') — slash commands registered.'); }
        catch (e) { console.error('Failed to register commands for new guild ' + gid + ':', (e && e.message) || e); }
    }
    const status = row && row.accessStatus ? row.accessStatus : await getGuildAccessStatus(gid);
    if (status === 'granted') { console.log('[guildAccess] guild ' + gid + ' already granted — onboarding skipped.'); return { status: 'granted', row }; }
    try {
        const stored = row || (await fetchGuildRow(gid).catch(() => null)) || {};
        const result = await ensureOnboardingForLockedGuild(client, guild, stored);
        return { status: status || 'pending', row, onboarding: result };
    } catch (e) { console.warn('[guildAccess] onboarding ensure failed:', (e && e.message) || e); return { status: status || 'pending', row }; }
}
async function handleGuildLeave(client, gidRaw) {
    try {
        await markGuildLeft(gidRaw);
        console.log('[guildAccess] left guild ' + gidRaw + ' — record preserved (bot_present=false).');
    } catch (e) { console.warn('[guildAccess] guildDelete failed:', (e && e.message) || e); }
}
async function reconcileGuildsOnReady(client) {
    let guilds = [];
    try { guilds = [...client.guilds.cache.values()]; } catch (_) { return { checked: 0, repaired: 0 }; }
    let repaired = 0;
    await Promise.allSettled(guilds.map(async (guild) => {
        try {
            let ownerId = null;
            try { const o = await guild.fetchOwner(); if (o && o.id) ownerId = o.id; } catch (_) {}
            let row = null;
            try {
                if (ownerId) { row = await upsertGuildOnJoin({ guildId: guild.id, guildName: guild.name, ownerId }); }
                else {
                    await ensureAccessTables();
                    const r = await sharedPingDb.runPoolQuery('INSERT INTO kakuzu_guilds (guild_id, guild_name, bot_present, left_at, updated_at) VALUES ($1, $2, TRUE, NULL, NOW()) ON CONFLICT (guild_id) DO UPDATE SET guild_name = EXCLUDED.guild_name, bot_present = TRUE, left_at = NULL, updated_at = NOW() RETURNING *',
                        [guild.id, guild.name], ACCESS_QUERY_TIMEOUT_MS);
                    row = r && r.rows && r.rows[0] ? mapRow(r.rows[0]) : null;
                    if (row && row.accessStatus) setCachedStatus(guild.id, row.accessStatus);
                }
            } catch (e) { console.warn('[guildAccess] ready upsert failed for ' + guild.id, sharedPingDb.sanitizeError(e)); return; }
            const status = row && row.accessStatus ? row.accessStatus : await getGuildAccessStatus(guild.id);
            if (status !== 'granted' && (!row || !row.onboardingChannelId || !row.onboardingMessageId)) {
                const stored = row || (await fetchGuildRow(guild.id).catch(() => null)) || {};
                const existing = await resolveExistingOnboardingChannel(client, guild, stored.onboardingChannelId);
                if (!existing || !stored.onboardingMessageId) { await ensureOnboardingForLockedGuild(client, guild, stored); repaired += 1; }
            }
        } catch (e) { console.warn('[guildAccess] ready reconcile failed:', (e && e.message) || e); }
    }));
    if (repaired > 0) console.log('[guildAccess] ready reconcile repaired onboarding for ' + repaired + ' locked guild(s).');
    return { checked: guilds.length, repaired };
}
module.exports = {
    ACCESS_CACHE_TTL_MS, ONBOARDING_CHANNEL_NAME,
    ensureAccessTables, getSupportGuildId, getBotOwnerId, getManagerRoleIds, getSupportUrl,
    getSuperAdminIds, isSuperAdmin, SUPERADMIN_USERNAMES,
    verifyAccessPassword, authorizeAccessManager,
    getGuildAccessStatus, isGuildGranted, getCachedStatus, setCachedStatus, invalidateGuildCache, getAccessCacheSize,
    fetchGuildRow, upsertGuildOnJoin, markGuildLeft, saveOnboardingRefs, saveOwnerDmStatus,
    grantGuildAccess, revokeGuildAccess, recordAccessEvent,
    buildPendingEmbed, buildGrantedEmbed, buildRevokedEmbed, buildOwnerDmPayload, buildLockedReply,
    buildMissingPermsDm, botMissingManageChannels,
    ACCESS_V2_FLAGS, ACCESS_CARD_KINDS, buildAccessV2Payload, buildAccessEmbedPayload,
    messageIsComponentsV2, isKakuzuAccessMessage,
    ensureOnboardingForLockedGuild, editOnboardingMessage, handleGuildJoin, handleGuildLeave, reconcileGuildsOnReady,
    getSupabaseDashboardUrl,
};



