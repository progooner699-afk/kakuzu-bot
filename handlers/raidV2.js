'use strict';

const rsm = require('./raidStateManager');

// Message flag required to enable native Components V2 (Separator etc).
// Note: with this flag Discord DISABLES content + embeds on the message.
const RAID_ALERT_V2_FLAGS = 1 << 15;

// Runtime newline used while composing Text Display content (avoids escape
// sequence mangling in the source file itself).
const NL10 = String.fromCharCode(10);

// Accent color for the container left color bar (Raid Alert red).
const ALERT_ACCENT_COLOR = 0xFF0000;

// Thin horizontal rule (U+2500) rendered directly beneath each section title in
// the V2 alert, mirroring the embed fallback EMBED_DIVIDER rule.
const DIVIDER = String.fromCharCode(0x2500).repeat(44);

function buildRaidAlertPayload(raid, buttons) {
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
        ? raid.helpers.map(function (h) {
            if (typeof h === 'string') return '<@' + h + '>';
            const name = h.robloxDisplayName || h.robloxUsername || (h.userId ? '<@' + h.userId + '>' : 'Unknown');
            return name;
        }).join(', ')
        : 'None';

    const text = function (content) { return { type: 10, content: content }; };
    const separator = function () { return { type: 14, divider: true, spacing: 1 }; };
    const section = function (tds) { return { type: 9, components: tds }; };

    const containerContents = [];

    // --- Section 1: header (title + status) ---
    containerContents.push(section([
        text('### 🚨 RAID ALERT #' + raid.raidId + NL10 + DIVIDER),
        text('**' + statusEmoji + ' ' + statusText + '** • <t:' + createdTs + ':F>' +
            (raid.region ? NL10 + '> **Region:** `' + raid.region + '`' : ''))
    ]));
    containerContents.push(separator());

    // --- Section 2: details ---
    containerContents.push(section([text('### 📋 DETAILS' + NL10 + DIVIDER + NL10 +
        '> **Game:** ' + gameLabel + NL10 +
        '> **Raid ID:** `' + raid.raidId + '`' + NL10 +
        '> **Target:** ' + targetDisplay +
        (raid.region ? NL10 + '> **Region:** `' + raid.region + '`' : '') + NL10 +
        '> **Status:** `' + statusEmoji + ' ' + statusText + '`' + NL10 +
        '> **Time Requested:** <t:' + createdTs + ':f>')]));
    containerContents.push(separator());

    // --- Section 3: in-game helpers ---
    containerContents.push(section([text('### ⚔️ IN-GAME HELPERS' + NL10 + DIVIDER + NL10 +
        '> **Helpers:** `' + helperNamesText + '`' + NL10 +
        '> **Total Helpers:** `' + helperCount + ' / ' + (raid.helperLimit || 0) + '`')]));
    containerContents.push(separator());

    // --- Section 4: description ---
    containerContents.push(section([text('### 📝 DESCRIPTION' + NL10 + DIVIDER + NL10 + '```' + NL10 + reasonText + NL10 + '```')]));

    // --- Section 5: live helpers ---
    if (helperCount > 0) {
        const liveHelpersList = raid.helpers.map(function (h) {
            if (typeof h === 'string') return '• <@' + h + '>';
            const name = h.robloxDisplayName || h.robloxUsername || (h.userId ? '<@' + h.userId + '>' : 'Unknown');
            const timeSpent = (h && h.timeSpentSeconds) ? ' ⏱ ' + rsm.formatTimeSpent(h.timeSpentSeconds) : '';
            return '• <@' + h.userId + '> — **' + name + '**' + timeSpent;
        }).join(NL10);
        containerContents.push(separator());
        containerContents.push(section([text('### 👥 LIVE HELPERS (' + helperCount + ' / ' + (raid.helperLimit || 0) + ')' + NL10 + DIVIDER + NL10 + liveHelpersList)]));
    }

    // --- Button row attached to the container ---
    if (buttons) {
        const rows = Array.isArray(buttons) ? buttons : [buttons];
        rows.forEach(function (r) { containerContents.push(typeof r.toJSON === "function" ? r.toJSON() : r); });
    }

    const container = { type: 17, accent_color: ALERT_ACCENT_COLOR, components: containerContents };

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
    buildRaidAlertPayload: buildRaidAlertPayload,
    markAlertV2: markAlertV2
};

