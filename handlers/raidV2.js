'use strict';

const {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    ThumbnailBuilder
} = require('discord.js');

const rsm = require('./raidStateManager');
const { getRobloxAvatarUrl } = require('./robloxApi');

// Message flag required to enable native Components V2 (Separator etc).
// Note: with this flag Discord DISABLES content + embeds on the message.
const RAID_ALERT_V2_FLAGS = 1 << 15;

// Runtime newline used while composing Text Display content (avoids escape
// sequence mangling in the source file itself).
const NL10 = String.fromCharCode(10);

// Accent color for the container left color bar (Raid Alert red).
const ALERT_ACCENT_COLOR = 0xED4245;

// Static game thumbnail for "The Strongest Battlegrounds" (Roblox placeId
// 1153846701). Fixed image for the game itself — does NOT change per-request.
const TSB_GAME_THUMBNAIL_URL = 'https://t6.rbxcdn.com/180DAY-007dc222a830b5992e1a04073454e980';

// Small in-memory avatar cache so we don't hammer the Roblox avatar-headshot
// API on every accept/leave edit of the same raid alert (10 minute TTL).
const avatarCache = new Map();
const AVATAR_CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeHelperName(h) {
    if (typeof h === 'string') return '<@' + h + '>';
    return h.robloxDisplayName || h.robloxUsername || (h.userId ? '<@' + h.userId + '>' : 'Unknown');
}

function formatLiveHelperRow(h) {
    if (typeof h === 'string') return '> • <@' + h + '>';
    const name = h.robloxDisplayName || h.robloxUsername || (h.userId ? '<@' + h.userId + '>' : 'Unknown');
    const timeSpent = (h && h.timeSpentSeconds) ? ' ⏱ ' + rsm.formatTimeSpent(h.timeSpentSeconds) : '';
    return '> • <@' + h.userId + '> — **' + name + '**' + timeSpent;
}

/**
 * Resolves the requester's CURRENT Roblox avatar-headshot URL dynamically from
 * the Roblox thumbnails API (per-user). Falls back to the avatar URL captured
 * at link/request time if the live fetch fails.
 */
async function resolveRequesterAvatarUrl(raid) {
    const userId = raid && (raid.robloxUserId || raid.requesterId);
    const stored = (raid && raid.robloxAvatarUrl) || null;
    if (!userId) return stored;

    const key = String(userId);
    const now = Date.now();
    const cached = avatarCache.get(key);
    if (cached && now - cached.at < AVATAR_CACHE_TTL_MS) return cached.url;

    let url = stored;
    try {
        const result = await getRobloxAvatarUrl(userId);
        if (result && result.success && result.avatarUrl) url = result.avatarUrl;
    } catch (err) {
        // keep the stored avatar fallback
    }
    avatarCache.set(key, { url, at: now });
    return url;
}

async function buildRaidAlertPayload(raid, buttons) {
    if (buttons === undefined) buttons = null;
    const helperCount = (raid.helpers && raid.helpers.length) || 0;
    const statusText = raid.status === 'OPEN' ? 'OPEN' : raid.status === 'FULL' ? 'FULL' : 'CLOSED';
    const gameLabel = (rsm.GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown');
    const createdMs = Number(raid.createdAt) || Date.now();
    const createdTs = Math.floor(createdMs / 1000);
    const reasonText = raid.reason ? raid.reason : 'No details provided';
    const statusEmoji = statusText === 'OPEN' ? '🟢' : statusText === 'FULL' ? '🟠' : '🔴';
    const targetDisplay = raid.robloxUsername || '<@' + raid.requesterId + '>';

    const helperNamesText = helperCount > 0
        ? raid.helpers.map(normalizeHelperName).join(', ')
        : 'None';

    // Edit 2a — requester's CURRENT Roblox pfp (live from the avatar-headshot API).
    const requesterAvatarUrl = await resolveRequesterAvatarUrl(raid);

    // Edit 1 — accent color bar on the Container (vertical colored line that
    // makes the whole alert look like a boxed embed). Container type = 17.
    // The ContainerBuilder is serialized while its component list is still
    // empty; the raw section/separator/row JSON is attached afterwards because
    // SectionBuilder in @discordjs/builders 1.14.x REQUIRES an accessory to
    // serialize, so accessory-less sections (IN-GAME HELPERS / DESCRIPTION /
    // LIVE HELPERS) must be emitted as plain type-9 JSON.
    const container = new ContainerBuilder().setAccentColor(ALERT_ACCENT_COLOR).toJSON();

    const text = function (content) { return new TextDisplayBuilder().setContent(content).toJSON(); };
    const separator = function () { return new SeparatorBuilder().setDivider(true).setSpacing(1).toJSON(); }; // type 14

    const containerContents = [];

    // --- Section 1: header (title + status) — carries the requester pfp ---
    const headerSection = new SectionBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('### 🚨 RAID ALERT #' + raid.raidId),
            new TextDisplayBuilder().setContent(
                '**' + statusEmoji + ' ' + statusText + '** • <t:' + createdTs + ':F>' +
                (raid.region ? NL10 + '> **Region:** `' + raid.region + '`' : '')
            )
        );
    if (requesterAvatarUrl) {
        headerSection.setThumbnailAccessory(new ThumbnailBuilder().setURL(requesterAvatarUrl));
        containerContents.push(headerSection.toJSON());
    } else {
        // No live avatar available — emit the section as plain JSON so the
        // SectionBuilder accessory-required validation is bypassed.
        containerContents.push({
            type: 9,
            components: headerSection.components.map(function (c) { return c.toJSON(); })
        });
    }
    containerContents.push(separator());

    // --- Section 2: details — carries the static game thumbnail ---
    containerContents.push(
        new SectionBuilder()
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(TSB_GAME_THUMBNAIL_URL))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '### 📋 DETAILS' + NL10 +
                '> **Game:** ' + gameLabel + NL10 +
                '> **Raid ID:** `' + raid.raidId + '`' + NL10 +
                '> **Target:** ' + targetDisplay +
                (raid.region ? NL10 + '> **Region:** `' + raid.region + '`' : '') + NL10 +
                '> **Status:** `' + statusEmoji + ' ' + statusText + '`' + NL10 +
                '> **Time Requested:** <t:' + createdTs + ':f>'
            ))
            .toJSON()
    );
    containerContents.push(separator());

    // --- Section 3: in-game helpers ---
    containerContents.push({ type: 9, components: [text('### ⚔️ IN-GAME HELPERS' + NL10 +
        '> **Helpers:** `' + helperNamesText + '`' + NL10 +
        '> **Total Helpers:** `' + helperCount + ' / ' + (raid.helperLimit || 0) + '`')] });
    containerContents.push(separator());

    // --- Section 4: description (plain text, no quote bar) ---
    containerContents.push({ type: 9, components: [text('### 📝 DESCRIPTION' + NL10 + '```' + NL10 + reasonText + NL10 + '```')] });
    containerContents.push(separator());

    // --- Section 5: live helpers (quote-bar'd @user — ⏱ time rows) ---
    if (helperCount > 0) {
        const liveHelpersList = raid.helpers.map(formatLiveHelperRow).join(NL10);
        containerContents.push({ type: 9, components: [text('### 👥 LIVE HELPERS (' + helperCount + ' / ' + (raid.helperLimit || 0) + ')' + NL10 + liveHelpersList)] });
        containerContents.push(separator());
    }

    // --- Button row attached to the container (JOIN SERVER / Join Raid / Close) ---
    if (buttons) {
        const rows = Array.isArray(buttons) ? buttons : [buttons];
        rows.forEach(function (r) {
            const apiRow = (r && typeof r.toJSON === 'function') ? r.toJSON() : r;
            if (apiRow) containerContents.push(apiRow);
        });
    }

    container.components = containerContents;

    return { flags: RAID_ALERT_V2_FLAGS, components: [container] };
}

function markAlertV2(raidId, guildId) {
    const raids = rsm.loadRaids(guildId);
    const raid = raids.raids.find(function (item) { return item.raidId === raidId; });
    if (!raid) return null;
    raid.alertFormat = 'v2';
    rsm.saveRaids(guildId, raids);
    return raid;
}

module.exports = {
    RAID_ALERT_V2_FLAGS: RAID_ALERT_V2_FLAGS,
    ALERT_ACCENT_COLOR: ALERT_ACCENT_COLOR,
    TSB_GAME_THUMBNAIL_URL: TSB_GAME_THUMBNAIL_URL,
    buildRaidAlertPayload: buildRaidAlertPayload,
    markAlertV2: markAlertV2
};

