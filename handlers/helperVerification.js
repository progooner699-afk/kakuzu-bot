'use strict';

/**
 * Helper-server verification core — PURE, no I/O, fully unit-testable.
 *
 * WHY THIS EXISTS (the public-server failure mode):
 * Roblox `gameId` (Job ID) identifies one *instance* of an experience. On a
 * PUBLIC server those instances churn constantly: an instance fills and closes
 * and Roblox teleports everyone to a fresh one (new jobId), the requester
 * disconnects and rejoins (new jobId), or the instance is recycled. Kakuzu used
 * to compare the helper's live jobId against `raid.serverId`, which is captured
 * exactly ONCE at createRaid and never refreshed — so the moment that id died,
 * `serverMatches` was false for everybody AND the place-level fallback was
 * disabled by an inverted guard (`&& !raid.serverId`), leaving the raid
 * permanently unable to admit a single helper.
 *
 * The model here is "accept on same experience, exclude ONLY on positive
 * contrary evidence":
 *
 *   exact_live      requester is live in the raid experience and the helper's
 *                   jobId equals the requester's CURRENT jobId (strongest).
 *                   Also reports `refreshServerId` when the recorded id is stale
 *                   so callers can self-heal the raid record.
 *   exact_recorded  requester is not live, but the helper's jobId equals the
 *                   raid's recorded serverId.
 *   place_fallback  same experience with no live reference able to contradict
 *                   it — DEGRADED but deliberately never a permanent lockout.
 *
 *   different_instance  requester IS live in the raid experience AND the helper
 *                   IS live with a DIFFERENT jobId → hard reject. This is the
 *                   cross-server false-positive guard, now keyed off a LIVE
 *                   reference instead of a possibly-dead recorded one.
 *
 * Place-level matching is never applied when the helper is demonstrably in a
 * different experience (`different_experience`).
 */

// Roblox presence enum: 0 Offline, 1 Online, 2 InGame, 3 InStudio, 4 Invisible.
// (The historic string comparison `'InGame'` never matched, which is why time
// tracking silently never fired.)
const PRESENCE_INGAME = 2;

const MATCH_TIERS = Object.freeze({
    EXACT_LIVE: 'exact_live',
    EXACT_RECORDED: 'exact_recorded',
    PLACE: 'place_fallback'
});

const NO_MATCH = Object.freeze({
    matched: false,
    tier: null,
    refreshServerId: null,
    referenceJobId: null,
    referenceMode: 'none'
});

function normalizeId(value) {
    if (value == null) return '';
    return String(value).trim();
}

/**
 * Normalizes a Roblox presence record (raw `userPresenceType`/`placeId`/`gameId`)
 * into a stable shape with STRING ids — raw presence values arrive as numbers or
 * null depending on the endpoint, and loose equality here is what caused the
 * historic "never matches" bug.
 */
function normalizePresence(raw) {
    if (!raw) {
        return { userId: null, presenceType: null, placeId: '', jobId: '', universeId: null };
    }
    const rawType = raw.userPresenceType != null ? Number(raw.userPresenceType) : NaN;
    return {
        userId: raw.userId != null ? String(raw.userId) : null,
        presenceType: Number.isFinite(rawType) ? rawType : null,
        placeId: normalizeId(raw.placeId),
        jobId: normalizeId(raw.gameId),
        universeId: raw.universeId != null ? normalizeId(raw.universeId) : null
    };
}

function isInGame(presence) {
    return Boolean(presence) && presence.presenceType === PRESENCE_INGAME;
}

/**
 * Resolves which jobId should be treated as "the raid's server" right now.
 *
 *   live      the requester is confirmed InGame INSIDE the raid experience and
 *             exposes a jobId → authoritative, and it is FRESH every poll.
 *   recorded  no live signal, but the raid carries a recorded serverId.
 *   none      nothing usable — callers may fall back to place-level matching.
 *
 * A requester who is InGame in some *other* experience does not get to gate
 * helpers in this one, so they resolve to `recorded`/`none`, not `live`.
 */
function resolveReferenceServer(raid, requesterPresence) {
    const recorded = normalizeId(raid && raid.serverId);
    const raidPlaceId = normalizeId(raid && raid.placeId);
    const requester = normalizePresence(requesterPresence);
    const requesterInRaidExperience = isInGame(requester) && Boolean(requester.jobId) &&
        (!raidPlaceId || !requester.placeId || requester.placeId === raidPlaceId);
    if (requesterInRaidExperience) return { mode: 'live', jobId: requester.jobId };
    if (recorded) return { mode: 'recorded', jobId: recorded };
    return { mode: 'none', jobId: '' };
}

/**
 * Decides whether a helper belongs in a raid's server.
 * @param {object} args
 * @param {object} args.raid               raid record (placeId/serverId)
 * @param {object} args.helperPresence     raw presence for the helper
 * @param {object} [args.requesterPresence] raw presence for the raid requester
 * @returns {{matched:boolean, tier:string|null, reason:string,
 *            referenceJobId:string|null, referenceMode:string,
 *            refreshServerId:string|null}}
 *   `refreshServerId` is non-null only when the caller should rewrite the
 *   raid's stale `serverId` with the requester's current one.
 */
function evaluateHelperMatch({ raid, helperPresence, requesterPresence }) {
    const helper = normalizePresence(helperPresence);
    const raidPlaceId = normalizeId(raid && raid.placeId);
    const ref = resolveReferenceServer(raid, requesterPresence);
    const base = {
        referenceJobId: ref.jobId || null,
        referenceMode: ref.mode,
        refreshServerId: null
    };

    if (!isInGame(helper)) {
        return Object.assign({}, NO_MATCH, base, { reason: 'helper_not_ingame' });
    }
    // Roblox privacy (joins limited / profile hidden) withholds BOTH fields:
    // there is nothing to verify against, so we must not guess a match.
    if (!helper.placeId && !helper.jobId) {
        return Object.assign({}, NO_MATCH, base, { reason: 'presence_hidden' });
    }
    // Different experience entirely → never a match, regardless of fallbacks.
    if (raidPlaceId && helper.placeId && helper.placeId !== raidPlaceId) {
        return Object.assign({}, NO_MATCH, base, { reason: 'different_experience' });
    }

    const requesterLive = ref.mode === 'live';

    // HARD cross-server reject — only when we hold live proof of a different
    // instance. Never applied to a merely-recorded (possibly dead) jobId.
    if (requesterLive && helper.jobId && ref.jobId && helper.jobId !== ref.jobId) {
        return Object.assign({}, NO_MATCH, base, { reason: 'different_instance' });
    }

    if (requesterLive && helper.jobId && helper.jobId === ref.jobId) {
        const stale = ref.jobId !== normalizeId(raid && raid.serverId);
        return Object.assign({}, base, {
            matched: true,
            tier: MATCH_TIERS.EXACT_LIVE,
            reason: 'same_instance_as_requester',
            refreshServerId: stale ? ref.jobId : null
        });
    }

    if (!requesterLive && ref.mode === 'recorded' && helper.jobId && helper.jobId === ref.jobId) {
        return Object.assign({}, base, {
            matched: true,
            tier: MATCH_TIERS.EXACT_RECORDED,
            reason: 'matches_recorded_server'
        });
    }

    // Degraded but NON-BLOCKING fallback: same experience and nothing live can
    // contradict it. This is what keeps a raid admissible after its recorded
    // jobId has died — the old inverted guard made this branch unreachable.
    if (helper.placeId && (!raidPlaceId || helper.placeId === raidPlaceId)) {
        return Object.assign({}, base, {
            matched: true,
            tier: MATCH_TIERS.PLACE,
            reason: 'same_experience_no_live_reference'
        });
    }

    return Object.assign({}, NO_MATCH, base, { reason: 'no_server_match' });
}

/**
 * Applies an active/idle transition to a helper record IN PLACE and banks
 * elapsed in-game time exactly once per transition.
 *
 * "Active" means CONFIRMED in the raid's server (not merely InGame somewhere),
 * so a helper who drifts into another instance stops accruing time and gets a
 * `leaveTime` — which is what makes the `→ Left:` branch of the live embed
 * reachable at all (previously only removeHelper set it, then spliced the row).
 *
 * @returns {{changed:boolean, wentActive:boolean, wentIdle:boolean}}
 */
function noteHelperActiveState(helper, active, now) {
    const at = typeof now === 'number' ? now : Date.now();
    const outcome = { changed: false, wentActive: false, wentIdle: false };
    if (!helper || typeof helper !== 'object') return outcome;

    if (active && !helper.lastSeenTime) {
        helper.lastSeenTime = at;
        helper.leaveTime = null; // rejoined → no longer "left"
        outcome.changed = true;
        outcome.wentActive = true;
        return outcome;
    }
    if (!active && helper.lastSeenTime) {
        const elapsed = Math.floor((at - helper.lastSeenTime) / 1000);
        if (elapsed > 0) helper.timeSpentSeconds = (helper.timeSpentSeconds || 0) + elapsed;
        helper.lastSeenTime = null;
        helper.leaveTime = at;
        outcome.changed = true;
        outcome.wentIdle = true;
    }
    return outcome;
}

module.exports = {
    PRESENCE_INGAME,
    MATCH_TIERS,
    normalizeId,
    normalizePresence,
    isInGame,
    resolveReferenceServer,
    evaluateHelperMatch,
    noteHelperActiveState
};

