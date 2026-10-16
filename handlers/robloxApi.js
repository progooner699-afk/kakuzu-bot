/**
 * Roblox API Helper Functions
 * Handles validation and data fetching from Roblox APIs
 */

// Every Roblox HTTP call is deadline-bounded: an unbounded fetch that hangs
// inside request_backup / Help / the 15s presence loop blows Discord's 3s ack
// window (the "suddenly stops responding" symptom) and piles up stuck ticks.
const { fetchWithTimeout } = require('./fetchTimeout');
const ROBLOX_FETCH_TIMEOUT_MS = 8000;

/**
 * Validates a Roblox username using the more reliable username resolution endpoint
 * @param {string} username - The Roblox username to validate
 * @returns {Promise<{success: boolean, userId: string, displayName: string, error?: string}>}
 */
async function validateRobloxUser(username) {
    try {
        // Use the dedicated username resolution endpoint for exact matches
        const response = await fetchWithTimeout(
            `https://users.roblox.com/v1/usernames/users`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    usernames: [username.trim()],
                    excludeBannedUsers: true
                })
            },
            ROBLOX_FETCH_TIMEOUT_MS
        );

        if (!response.ok) {
            return { success: false, error: `Roblox API error: ${response.status}` };
        }

        const data = await response.json();

        // Check if user was found
        if (!data.data || data.data.length === 0) {
            return { success: false, error: `Roblox username "${username}" not found. Please verify the spelling.` };
        }

        const user = data.data[0];
        if (!user || !user.id) {
            return { success: false, error: `Could not resolve Roblox username "${username}".` };
        }

        return {
            success: true,
            userId: user.id.toString(),
            displayName: user.displayName || user.name || username
        };
    } catch (error) {
        console.error('Roblox user validation error:', error);
        return { success: false, error: 'Failed to validate Roblox username. Please try again.' };
    }
}

/**
 * Fetches a Roblox user's avatar headshot URL
 * @param {string} userId - The Roblox user ID
 * @returns {Promise<{success: boolean, avatarUrl?: string, error?: string}>}
 */
async function getRobloxAvatarUrl(userId) {
    try {
        const response = await fetchWithTimeout(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`,
            {},
            ROBLOX_FETCH_TIMEOUT_MS
        );

        if (!response.ok) {
            return { success: false, error: `Failed to fetch avatar: ${response.status}` };
        }

        const data = await response.json();

        // Check if we got avatar data
        if (!data.data || data.data.length === 0) {
            return { success: false, error: 'Could not fetch avatar image' };
        }

        const imageUrl = data.data[0].imageUrl;
        if (!imageUrl) {
            return { success: false, error: 'Avatar URL not found' };
        }

        return { success: true, avatarUrl: imageUrl };
    } catch (error) {
        console.error('Roblox avatar fetch error:', error);
        return { success: false, error: 'Failed to fetch Roblox avatar.' };
    }
}

/**
 * Complete validation: checks username and fetches avatar in one call
 * @param {string} username - The Roblox username to validate
 * @returns {Promise<{success: boolean, userId?: string, displayName?: string, avatarUrl?: string, error?: string}>}
 */
async function validateAndGetAvatar(username) {
    // Step 1: Validate username and get user ID
    const userValidation = await validateRobloxUser(username);
    if (!userValidation.success) {
        return userValidation;
    }

    // Step 2: Fetch avatar URL using the user ID
    const avatarResult = await getRobloxAvatarUrl(userValidation.userId);
    if (!avatarResult.success) {
        return avatarResult;
    }

    return {
        success: true,
        userId: userValidation.userId,
        displayName: userValidation.displayName,
        avatarUrl: avatarResult.avatarUrl
    };
}

/**
 * Gets the current presence of a Roblox user
 * @param {string} userId - The Roblox user ID
 * @returns {Promise<{success: boolean, gameId?: string, gameName?: string, serverId?: string, joinScript?: string, error?: string}>}
 */
async function getUserPresence(userId) {
    try {
        const response = await fetchWithTimeout(
            `https://presence.roblox.com/v1/presence/users`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userIds: [userId] })
            },
            ROBLOX_FETCH_TIMEOUT_MS
        );

        if (!response.ok) {
            console.warn(`[KAKUZU:ROBUX] userId=${userId} presenceFetchFailed=true httpStatus=${response.status} endpoint=https://presence.roblox.com/v1/presence/users`);
            return { success: false, error: `Failed to fetch presence: ${response.status}` };
        }

        const data = await response.json();

        if (!data.userPresences || data.userPresences.length === 0) {
            console.warn(`[KAKUZU:ROBUX] userId=${userId} noPresenceData=true endpoint=https://presence.roblox.com/v1/presence/users`);
            return { success: false, error: 'No presence data found' };
        }

        const presence = data.userPresences[0];

        if (presence.userPresenceType !== 2 && presence.userPresenceType !== 3) {
            console.warn(`[KAKUZU:ROBUX] userId=${userId} userPresenceType=${presence.userPresenceType ?? 'unknown'} notInGame=true`);
            return { success: false, error: 'User is not currently in a game' };
        }

        const placeId = presence.placeId;
        const gameId = presence.gameId;
        console.log(`[KAKUZU:ROBUX] userId=${userId} placeId=${placeId ?? 'n/a'} jobId=${gameId ?? 'n/a'} userPresenceType=${presence.userPresenceType ?? 'unknown'}`);

        if (!placeId) {
            console.warn(`[KAKUZU:ROBUX] userId=${userId} missingPlaceId=true`);
            return { success: false, error: 'No game place ID found' };
        }

        const universeResponse = await fetchWithTimeout(
            `https://games.roblox.com/v1/games?universeIds=${presence.universeId}`,
            {},
            ROBLOX_FETCH_TIMEOUT_MS
        );

        let gameName = 'Unknown Game';
        if (universeResponse.ok) {
            const universeData = await universeResponse.json();
            if (universeData.data && universeData.data.length > 0) {
                gameName = universeData.data[0].name;
            }
        }

        let joinScript = '';
        if (gameId) {
            const serverResponse = await fetchWithTimeout(
                `https://games.roblox.com/v1/games/${placeId}/servers/${gameId}`,
                {},
                ROBLOX_FETCH_TIMEOUT_MS
            );

            if (serverResponse.ok) {
                const serverData = await serverResponse.json();
                if (serverData.joinScript) {
                    joinScript = serverData.joinScript;
                }
            }
        }

        return {
            success: true,
            gameId: placeId.toString(),
            universeId: presence.universeId,
            placeId,
            gameName,
            serverId: gameId,
            joinScript
        };
    } catch (error) {
        console.error(`[KAKUZU:ROBUX] userId=${userId} presenceFetchError=${(error && error.message) || String(error)}`);
        return { success: false, error: 'Failed to fetch Roblox presence' };
    }
}

/**
 * Detects the game and region from Roblox presence
 * @param {string} userId - The Roblox user ID
 * @returns {Promise<{success: boolean, game?: string, region?: string, serverLink?: string, error?: string}>}
 */
async function detectGameAndRegion(userId) {
    const presence = await getUserPresence(userId);

    if (!presence.success) {
        return presence;
    }

    const gameName = presence.gameName.toLowerCase();
    let detectedGame = 'unknown';
    let detectedRegion = 'NA';
    let detectedCountryCode = null;
    let regionLabel = null;
    let regionSource = null;

    if (gameName.includes('strongest battlegrounds') || gameName.includes('tsb')) {
        detectedGame = 'tsb';
    } else if (gameName.includes('rivals')) {
        detectedGame = 'rivals';
    } else if (gameName.includes('bed wars') || gameName.includes('bedwars')) {
        detectedGame = 'bedwars';
    } else if (gameName.includes('blox fruits')) {
        detectedGame = 'bloxfuits';
        detectedRegion = 'ASIA';
    } else if (gameName.includes('jujutsu') || gameName.includes('jjk')) {
        detectedGame = 'jjk';
    } else if (gameName.includes('fish')) {
        detectedGame = 'fishtrap';
    }

    if (presence.serverId && presence.placeId) {
        try {
            const { getServerIp } = require('./robloxAuth');
            const ipResult = await getServerIp(presence.placeId, presence.serverId);
            const hasServerLocationData = Boolean(ipResult && (ipResult.machineAddress || ipResult.publicAddress || ipResult.dataCenterId));
            const guildContext = { guildId: 'unknown', guildName: 'unknown', placeId: presence.placeId, serverId: presence.serverId, robloxUsername: userId ? String(userId) : 'unknown' };

            console.log(`[KAKUZU:REGION] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} serverDetectionStarted=true machineAddressFound=${Boolean(ipResult && ipResult.machineAddress)} publicAddressFound=${Boolean(ipResult && ipResult.publicAddress)} dataCenterId=${JSON.stringify(ipResult && ipResult.dataCenterId ? String(ipResult.dataCenterId) : 'none')}`);

            if (ipResult && (ipResult.machineAddress || ipResult.dataCenterId)) {
                const { resolveRoValraDatacenterRegion, geolocateIp, normalizeCountryToRegion, normalizeCountryCodeToRegion } = require('./regionMap');
                let resolved = null;
                let resolvedLabel = null;
                let source = null;

                try {
                    const rovalra = await resolveRoValvaDatacenterRegion(ipResult.dataCenterId, guildContext);
                    if (rovalra && (rovalra.region || rovalra.countryCode)) {
                        resolved = rovalra.region || null;
                        detectedCountryCode = rovalra.countryCode || null;
                        resolvedLabel = rovalra.label || null;
                        source = 'RoValra';
                        console.log(`[KAKUZU:REGION] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} resolvedFromRoValra=true country=${JSON.stringify(detectedCountryCode || 'unknown')} mappedRegion=${JSON.stringify(resolved || 'unknown')}`);
                    } else {
                        console.warn(`[KAKUZU:ROVALRA] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} machineAddressMissingFromResponse=true dataCenterId=${JSON.stringify(ipResult && ipResult.dataCenterId ? String(ipResult.dataCenterId) : 'none')}`);
                    }
                } catch (err) {
                    console.warn(`[KAKUZU:ROVALRA] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} rovalraFailure=true error=${(err && err.message) || String(err)}`);
                }

                if (!resolved && (ipResult.publicAddress || ipResult.machineAddress)) {
                    const ipCandidate = ipResult.publicAddress || ipResult.machineAddress;
                    console.log(`[KAKUZU:IP] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} addressCandidate=${JSON.stringify(ipCandidate || 'none')} machineAddressFound=${Boolean(ipResult.machineAddress)} publicAddressFound=${Boolean(ipResult.publicAddress)}`);
                    try {
                        const geo = await geolocateIp(ipCandidate, guildContext);
                        if (geo) {
                            resolved = normalizeCountryToRegion(geo.country)
                                || normalizeCountryCodeToRegion(geo.countryCode)
                                || geo.label;
                            detectedCountryCode = geo.countryCode || null;
                            resolvedLabel = geo.label;
                            source = 'ip-api';
                            console.log(`[KAKUZU:REGION] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} resolvedFromIp=true country=${JSON.stringify(detectedCountryCode || 'unknown')} mappedRegion=${JSON.stringify(resolved || 'unknown')}`);
                        } else {
                            console.warn(`[KAKUZU:IP] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} IP geolocation failed`);
                        }
                    } catch (err) {
                        console.error(`[KAKUZU:IP] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} IP geolocation failed error=${(err && err.message) || String(err)}`);
                    }
                }

                detectedRegion = resolved || 'Unknown';
                regionLabel = resolvedLabel;
                regionSource = source;
                console.log(`[KAKUZU:REGION] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} finalRegion=${JSON.stringify(detectedRegion)} countryCode=${JSON.stringify(detectedCountryCode || 'unknown')} regionSource=${JSON.stringify(source || 'unknown')} label=${JSON.stringify(resolvedLabel || 'unknown')}`);
            } else {
                console.warn(`[KAKUZU:REGION] guild=${guildContext.guildId} guildName=${JSON.stringify(guildContext.guildName)} placeId=${presence.placeId} jobId=${JSON.stringify(presence.serverId)} robloxUser=${JSON.stringify(guildContext.robloxUsername)} noServerLocationData=true`);
            }
        } catch (err) {
            console.error(`[KAKUZU:REGION] guild=unknown guildName="unknown" placeId=${presence.placeId ?? 'n/a'} jobId=${JSON.stringify(presence.serverId || 'n/a')} robloxUser=${JSON.stringify(userId || 'unknown')} gamejoinRegionLookupFailed=true error=${(err && err.message) || String(err)}`);
        }
    }

    let serverLink = '';
    if (presence.joinScript) {
        const match = presence.joinScript.match(/(https?:\/\/[^\s"']+)/);
        if (match) {
            serverLink = match[1];
        }
    }

    if (!serverLink && presence.placeId) {
        serverLink = `https://www.roblox.com/games/${presence.placeId}`;
    }

    if (presence.universeId) {
        try {
            const thumbResponse = await fetchWithTimeout(
                `https://thumbnails.roblox.com/v1/games/icons?universeIds=${presence.universeId}&size=512x512&format=Png&isCircular=false`,
                {},
                ROBLOX_FETCH_TIMEOUT_MS
            );
            if (thumbResponse.ok) {
                const thumbData = await thumbResponse.json();
                if (thumbData.data && thumbData.data.length > 0) {
                    gameIconUrl = thumbData.data[0].imageUrl || '';
                }
            }
        } catch (err) {
            // ignore — thumbnail is optional
        }
    }

    return {
        success: true,
        game: detectedGame,
        region: detectedRegion,
        regionLabel: regionLabel || null,
        regionSource: regionSource || null,
        countryCode: detectedCountryCode || null,
        serverLink,
        gameName: presence.gameName,
        gameIconUrl,
        placeId: presence.placeId,
        serverId: presence.serverId
    };
}

module.exports = {
    validateRobloxUser,
    getRobloxAvatarUrl,
    validateAndGetAvatar,
    getUserPresence,
    detectGameAndRegion
};
