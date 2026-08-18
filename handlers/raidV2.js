'use strict';

const {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
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

// Game-specific thumbnail map — per-raid-game artwork.
const GAME_THUMBNAILS = {
    'tsb': 'https://t6.rbxcdn.com/180DAY-007dc222a830b5992e1a04073454e980',
    'jjk': 'https://t6.rbxcdn.com/3e8a3e4e5e6e7e8e9e0e1e2e3e4e5e6e7e8f0f1',
    'rivals': 'https://t6.rbxcdn.com/180DAY-rivals-placeholder',
    'bedwars': 'https://t6.rbxcdn.com/180DAY-bedwars-placeholder',
    'bloxfuits': 'https://t6.rbxcdn.com/180DAY-bloxfuits-placeholder',
	// Add more game thumbnails as needed; fallback below handles the rest.
};

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
        // a Section (type 9) ALWAYS requires an accessory (Discord rejects
    // accessory-less Sections with BASE_TYPE_REQUIRED), so blocks without a
    // thumbnail/button (IN-GAME HELPERS / DESCRIPTION / LIVE HELPERS, and the
    // header when there is no requester avatar) are emitted as TextDisplay
    // (type 10) via text() instead - no accessory is required.
    const container = new ContainerBuilder().setAccentColor(ALERT_ACCENT_COLOR).toJSON();
    // Use large container size — makes the alert ~600px wide instead of ~400px
    container.size = 'large';

    const text = function (content) { return new TextDisplayBuilder().setContent(content).toJSON(); };
    // Native V2 Separator with the divider line explicitly ON (this is what
    // actually draws the horizontal bar) and Small spacing.
    const separator = function () { return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small).toJSON(); }; // type 14

    const containerContents = [];
    const sections = [];

    // --- Section 1: header (title) — carries the requester pfp ---
    const headerSection = new SectionBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('### 🚨 RAID ALERT #' + raid.raidId),
            new TextDisplayBuilder().setContent(
                '<t:' + createdTs + ':F>'
            )
        );
    if (requesterAvatarUrl) {
        headerSection.setThumbnailAccessory(new ThumbnailBuilder().setURL(requesterAvatarUrl));
        sections.push(headerSection.toJSON());
    } else {
        // No requester avatar - a Section (type 9) ALWAYS needs an accessory,
        // so merge the header's text displays into a single TextDisplay (type 10),
        // which needs no accessory and won't be rejected by Discord.
        const headerTexts = headerSection.components
            .map(function (c) { var j = c.toJSON(); return j && j.content; })
            .filter(Boolean);
        sections.push(text(headerTexts.join(NL10)));
    }
// Edit 2 — extra separator after header
    console.log('[thumbnail lookup]', raid.targetGame, '->', GAME_THUMBNAILS[raid.targetGame] || 'NO MATCH, using fallback');
    sections.push(
        new SectionBuilder()
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(GAME_THUMBNAILS[raid.targetGame] || GAME_THUMBNAILS['tsb'] || 'https://t6.rbxcdn.com/180DAY-007dc222a830b5992e1a04073454e980'))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '### 📋 DETAILS' + NL10 + NL10 +
                '> **Raid Target:** ' + targetDisplay + NL10 +
                '> **Game:** ' + gameLabel + NL10 +
                '> **Raid ID:** `' + raid.raidId + '`' + NL10 +
                (raid.region ? '> **Region:** `' + raid.region + '`' + NL10 : '') +
                '> **Status:** `' + statusEmoji + ' ' + statusText + '`' + NL10 +
                '> **Time Requested:** <t:' + createdTs + ':f>'
            ))
            .toJSON()
    );

    // --- Section 3: in-game helpers ---
    sections.push(text('### ♟️ IN-GAME HELPERS' + NL10 + NL10 +
        '> **Helpers Needed:** `' + helperNamesText + '`' + NL10 +
        '> **Total Helpers Joined:** `' + helperCount + ' / ' + (raid.helperLimit || 0) + '`'));

    // --- Section 4: description (plain text, no quote bar) ---
    sections.push(text('### 📝 DESCRIPTION' + NL10 + NL10 + '```' + NL10 + reasonText + NL10 + NL10 + '```'));

    // --- Section 5: live helpers (quote-bar'd @user — ⏱ time rows) ---
    if (helperCount > 0) {
        const liveHelpersList = raid.helpers.map(formatLiveHelperRow).join(NL10);
        sections.push(text('### 👥 LIVE HELPERS (' + helperCount + ' / ' + (raid.helperLimit || 0) + ')' + NL10 + NL10 + liveHelpersList));
    }

    // Every section/title block is followed by a native V2 Separator (type 14).
    // Because the buttons row is appended after this loop, it too is always
    // preceded by a separator.
    sections.forEach(function (s) {
        containerContents.push(s);
        containerContents.push(separator());
    });

    // --- Button row attached to the container (Join Raid / Close) ---
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
    GAME_THUMBNAILS: GAME_THUMBNAILS,
    buildRaidAlertPayload: buildRaidAlertPayload,
    markAlertV2: markAlertV2
};


