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
const robloxLinks = require('./robloxLinks');
const raidV2 = require('./raidV2');
// Shared tiered matcher — one implementation for auto-join, Help monitors and
// helper time tracking (the old inline predicate was duplicated and broken).
const { evaluateHelperMatch } = require('./helperVerification');

// Roblox presence API caps the userIds array; stay safely under the limit.
const PRESENCE_CHUNK_SIZE = 200;
// Hard deadline per presence chunk: an unbounded fetch here stalls the 15s
// loop tick and piles up overlapping polls (the "process running but dead"
// symptom) when Roblox hangs instead of answering.
const { fetchWithTimeout } = require('./fetchTimeout');
const PRESENCE_FETCH_TIMEOUT_MS = 8000;

async function pollAutoJoin(client, guildId) {
    const apiKey = process.env.ROBLOX_API_KEY;
    if (!apiKey) return;

    const raids = raidStateManager.loadRaids(guildId);
    const openRaids = raids.raids.filter(r =>
        r.status === 'OPEN' && r.placeId && Array.isArray(r.helpers));
    if (openRaids.length === 0) return;

    // Linked users who could potentially be auto-added.
    // GLOBAL links (Supabase) are authoritative so a link from any guild
    // applies here; the per-guild legacy DB is a fallback mirror only.
    let linked;
    try {
        linked = await robloxLinks.getAllGlobalLinksForAutoJoin(guildId);
    } catch (err) {
        console.warn('[auto-join] global link read failed:', (err && err.message) || err);
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

    // Requesters are polled in the SAME batch: their CURRENT jobId is the
    // authoritative reference for exact instance matching (and lets us self-heal
    // a stale raid.serverId). They are excluded as candidates above, not queried.
    const idsToFetch = new Set(candidates.map(u => String(u.roblox_user_id)));
    for (const r of openRaids) {
        const rid = String(r.robloxUserId == null ? '' : r.robloxUserId).trim();
        if (rid && rid !== '1') idsToFetch.add(rid);
    }

    // Ask Roblox presence (chunked) — failures are non-fatal, next tick retries.
    const presenceByRobloxId = new Map();
    const allIds = [...idsToFetch];
    for (let i = 0; i < allIds.length; i += PRESENCE_CHUNK_SIZE) {
        const chunk = allIds.slice(i, i + PRESENCE_CHUNK_SIZE);
        try {
            const response = await fetchWithTimeout('https://presence.roblox.com/v1/presence/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                body: JSON.stringify({ userIds: chunk })
            }, PRESENCE_FETCH_TIMEOUT_MS);
            if (!response.ok) {
                console.warn('[auto-join] presence API HTTP', response.status);
                continue;
            }
            const data = await response.json();
            for (const record of (data.userPresences || data.data || [])) {
                presenceByRobloxId.set(String(record.userId), record);
            }
        } catch (err) {
            console.warn('[auto-join] presence API error:', (err && err.message) || err);
        }
    }
    if (presenceByRobloxId.size === 0) return;

    const changedRaids = new Map();
    for (const [robloxId, user] of presenceByRobloxId) {
        const info = byRobloxId.get(robloxId);
        if (!info) continue; // a requester (or unrelated id) — not an auto-join candidate

        // Shared tiered matcher: exact instance when a live reference exists,
        // the recorded instance otherwise, and a same-experience fallback that
        // can NEVER permanently lock a raid out after its jobId churns — the old
        // `serverMatches || (placeMatches && !r.serverId)` guard was inverted, so
        // once a recorded jobId died no helper could ever be added again.
        let raid = null;
        let verdict = null;
        for (const candidate of openRaids) {
            const requesterPresence =
                presenceByRobloxId.get(String(candidate.robloxUserId == null ? '' : candidate.robloxUserId)) || null;
            const outcome = evaluateHelperMatch({ raid: candidate, helperPresence: user, requesterPresence });
            if (outcome.matched) { raid = candidate; verdict = outcome; break; }
        }
        if (!raid || !verdict) continue;

        // Self-heal: adopt the requester's live instance as the raid's server.
        // Persisted via the setter because addHelper() reloads raids from disk.
        if (verdict.refreshServerId && raid.serverId !== verdict.refreshServerId) {
            raidStateManager.setRaidServerId(raid.raidId, verdict.refreshServerId, guildId);
            raid.serverId = verdict.refreshServerId;
            console.log('[auto-join] raid #' + raid.raidId + ' serverId refreshed (requester moved instances)');
        }

        const result = await raidStateManager.addHelper(raid.raidId, info.userId, {
            username: info.roblox_username,
            displayName: info.roblox_display_name || info.roblox_username,
            userId: String(info.roblox_user_id),
            avatarUrl: info.roblox_avatar_url || null
        }, guildId);
        if (result && result.success) {
            changedRaids.set(raid.raidId, result.raid);
            console.log('[auto-join] <@' + info.userId + '> (' + info.roblox_username +
                ') auto-joined raid #' + raid.raidId + ' via presence (tier ' + verdict.tier + ')');
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
