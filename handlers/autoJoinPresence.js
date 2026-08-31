'use strict';

/**
 * Presence-based AUTO-JOIN engine.
 *
 * Every poll (15s, driven by events/ready.js) this module:
 *  1. Loads all LINKED (verified) Roblox users from the guild's verification DB.
 *  2. Asks the Roblox Presence API (needs ROBLOX_API_KEY) whether any of them
 *     are currently InGame (userPresenceType === 2).
 *  3. If a linked user is in the SAME experience (matching placeId) as an OPEN
 *     raid, they are automatically added to that raid's helper list and the
 *     raid alert message is re-rendered so the LIVE HELPERS section updates
 *     without anyone having to click "Join Raid" and fill the modal.
 *
 * No-op when ROBLOX_API_KEY is unset (same behavior as pollHelperPresences).
 */
const raidStateManager = require('./raidStateManager');
const verificationDb = require('./verificationDb');
const raidV2 = require('./raidV2');

// Roblox presence API caps the userIds array; stay safely under the limit.
const PRESENCE_CHUNK_SIZE = 200;

async function pollAutoJoin(client, guildId) {
    const apiKey = process.env.ROBLOX_API_KEY;
    if (!apiKey) return;

    const raids = raidStateManager.loadRaids(guildId);
    const openRaids = raids.raids.filter(r =>
        r.status === 'OPEN' && r.placeId && Array.isArray(r.helpers));
    if (openRaids.length === 0) return;

    // Linked users who could potentially be auto-added.
    let linked;
    try {
        linked = await verificationDb.getAllVerifiedUsers(guildId);
    } catch (err) {
        console.warn('[auto-join] verification DB read failed:', (err && err.message) || err);
        return;
    }
    if (!linked || linked.length === 0) return;

    // Users already helping an active raid (or requesting one) are excluded.
    const excluded = new Set();
    for (const r of raids.raids) {
        if (r.status === 'CLOSED') continue;
        for (const h of (r.helpers || [])) excluded.add(typeof h === 'string' ? h : h.userId);
        if (r.requesterId) excluded.add(r.requesterId);
    }
    const candidates = linked.filter(u =>
        u.userId && u.roblox_user_id && String(u.roblox_user_id) !== '1' &&
        !excluded.has(u.userId));
    if (candidates.length === 0) return;

    const byRobloxId = new Map(candidates.map(u => [String(u.roblox_user_id), u]));

    // Ask Roblox presence (chunked) — failures are non-fatal, next tick retries.
    const presences = [];
    for (let i = 0; i < candidates.length; i += PRESENCE_CHUNK_SIZE) {
        const chunk = candidates.slice(i, i + PRESENCE_CHUNK_SIZE)
            .map(u => String(u.roblox_user_id));
        try {
            const response = await fetch('https://presence.roblox.com/v1/presence/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                body: JSON.stringify({ userIds: chunk })
            });
            if (!response.ok) {
                console.warn('[auto-join] presence API HTTP', response.status);
                continue;
            }
            const data = await response.json();
            presences.push(...(data.userPresences || data.data || []));
        } catch (err) {
            console.warn('[auto-join] presence API error:', (err && err.message) || err);
        }
    }
    if (presences.length === 0) return;

    const changedRaids = new Map();
    for (const user of presences) {
        if (user.userPresenceType !== 2) continue; // 2 = InGame
        const placeId = user.placeId != null ? String(user.placeId) : '';
        if (!placeId) continue;
        const info = byRobloxId.get(String(user.userId));
        if (!info) continue;
        // First non-full OPEN raid for this place.
        const raid = openRaids.find(r =>
            String(r.placeId) === placeId &&
            (r.helpers || []).length < (r.helperLimit || 0));
        if (!raid) continue;

        const result = await raidStateManager.addHelper(raid.raidId, info.userId, {
            username: info.roblox_username,
            displayName: info.roblox_display_name || info.roblox_username,
            userId: String(info.roblox_user_id),
            avatarUrl: info.roblox_avatar_url || null
        }, guildId);
        if (result && result.success) {
            changedRaids.set(raid.raidId, result.raid);
            console.log('[auto-join] <@' + info.userId + '> (' + info.roblox_username +
                ') auto-joined raid #' + raid.raidId + ' via presence (place ' + placeId + ')');
        }
    }

    // Re-render the alert message for every raid that gained a helper.
    for (const raid of changedRaids.values()) {
        await updateAlertMessage(client, raid, guildId);
    }
}

/**
 * Re-renders a raid's alert message (V2 components or embed fallback) after the
 * helper list changed. Never throws.
 */
async function updateAlertMessage(client, raid, guildId) {
    try {
        if (!raid || !raid.channelId || !raid.messageId) return;

        // Lazily required to avoid a load-time cycle with events/interactionCreate.
        const { createRaidButtons } = require('../events/interactionCreate');
        const guild = client.guilds.cache.get(guildId);
        const member = raid.requesterId && guild
            ? (guild.members.cache.get(raid.requesterId) || null)
            : null;
        const row = createRaidButtons(raid, member);

        // Alerts are authored by the 'backupalerts' webhook, so edits go
        // through the webhook too (message.edit is rejected for webhook posts).
        if (raid.alertFormat === 'v2') {
            const payload = await raidV2.buildRaidAlertPayload(raid, row);
            await raidStateManager.editRaidAlertMessage(client, raid, { flags: raidV2.RAID_ALERT_V2_FLAGS, components: payload.components });
        } else {
            const embeds = raidStateManager.formatRaidMessage(raid, guildId);
            await raidStateManager.editRaidAlertMessage(client, raid, { embeds: embeds, components: [row] });
        }
    } catch (err) {
        console.warn('[auto-join] alert update failed:', (err && err.message) || err);
    }
}

module.exports = { pollAutoJoin, updateAlertMessage };
