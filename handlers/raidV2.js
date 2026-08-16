'use strict';

const rsm = require('./raidStateManager');

// Message flag required to enable native Components V2 (Separator etc).
// Note: with this flag Discord DISABLES content + embeds on the message.
const RAID_ALERT_V2_FLAGS = 1 << 15;

// Runtime newline used while composing Text Display content (avoids escape
// sequence mangling in the source file itself).
const NL10 = String.fromCharCode(10);

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

    const helperNamesList = helperCount > 0
        ? raid.helpers.map(function (h) {
            if (typeof h === 'string') return '<@' + h + '>';
            const name = h.robloxDisplayName || h.robloxUsername || (h.userId ? '<@' + h.userId + '>' : 'Unknown');
            return name;
        }).join(', ')
        : 'None';

    const components = [];
    const text = function (content) { return { type: 10, content: content }; };
    const divider = function () { return { type: 14, divider: true, spacing: 1 }; };

    // --- Header ---
    components.push(text('### 🚨 RAID ALERT #' + raid.raidId));
    components.push(text('**' + statusEmoji + ' ' + statusText + '** • <t:' + createdTs + ':F>' +
        (raid.region ? NL10 + '> **Region:** `' + raid.region + '`' : '')));
    components.push(divider());

    // --- Details ---
    components.push(text('### 📋 DETAILS' + NL10 +
        '> **Game:** ' + gameLabel + NL10 +
        '> **Raid ID:** `' + raid.raidId + '`' + NL10 +
        '> **Target:** ' + targetDisplay +
        (raid.region ? NL10 + '> **Region:** `' + raid.region + '`' : '') + NL10 +
        '> **Status:** `' + statusEmoji + ' ' + statusText + '`' + NL10 +
        '> **Time Requested:** <t:' + createdTs + ':f>'));
    components.push(divider());

    // --- In-game helpers ---
    components.push(text('### ⚔️ IN-GAME HELPERS' + NL10 +
        '> **Helpers:** `' + helperNamesList + '`' + NL10 +
        '> **Total Helpers:** `' + helperCount + ' / ' + (raid.helperLimit || 0) + '`'));
    components.push(divider());

    // --- Description ---
    components.push(text('### 📝 DESCRIPTION' + NL10 + '```' + NL10 + reasonText + NL10 + '```'));

    // --- Live helpers ---
    if (helperCount > 0) {
        const liveHelpersList = raid.helpers.map(function (h) {
            if (typeof h === 'string') return '• <@' + h + '>';
            const name = h.robloxDisplayName || h.robloxUsername || (h.userId ? '<@' + h.userId + '>' : 'Unknown');
            const timeSpent = (h && h.timeSpentSeconds) ? ' ⏱ ' + rsm.formatTimeSpent(h.timeSpentSeconds) : '';
            return '• <@' + h.userId + '> — **' + name + '**' + timeSpent;
        }).join(NL10);
        components.push(divider());
        components.push(text('### 👥 LIVE HELPERS (' + helperCount + ' / ' + (raid.helperLimit || 0) + ')' + NL10 + liveHelpersList));
    }

    // --- Button row (legacy ActionRow still works on V2 messages) ---
    if (buttons) {
        const rows = Array.isArray(buttons) ? buttons : [buttons];
        rows.forEach(function (r) { components.push(typeof r.toJSON === "function" ? r.toJSON() : r); });
    }

    return { flags: RAID_ALERT_V2_FLAGS, components: components };
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
    buildRaidAlertPayload: buildRaidAlertPayload,
    markAlertV2: markAlertV2
};
