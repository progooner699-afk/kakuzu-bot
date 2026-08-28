/**
 * Roblox API Helper Functions
 * Handles validation and data fetching from Roblox APIs
 */

/**
 * Validates a Roblox username using the more reliable username resolution endpoint
 * @param {string} username - The Roblox username to validate
 * @returns {Promise<{success: boolean, userId: string, displayName: string, error?: string}>}
 */
async function validateRobloxUser(username) {
    try {
        // Use the dedicated username resolution endpoint for exact matches
        const response = await fetch(
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
            }
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
        const response = await fetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`
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
        const response = await fetch(
            `https://presence.roblox.com/v1/presence/users`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userIds: [userId] })
            }
        );

        if (!response.ok) {
            return { success: false, error: `Failed to fetch presence: ${response.status}` };
        }

        const data = await response.json();

        if (!data.userPresences || data.userPresences.length === 0) {
            return { success: false, error: 'No presence data found' };
        }

        const presence = data.userPresences[0];
        
        // userPresenceType 2 = InGame, 3 = InStudio
        if (presence.userPresenceType !== 2 && presence.userPresenceType !== 3) {
            return { success: false, error: 'User is not currently in a game' };
        }

        const placeId = presence.placeId;
        const gameId = presence.gameId;
        console.log('DEBUG placeId:', placeId, 'serverId:', gameId);
        
        if (!placeId) {
            return { success: false, error: 'No game place ID found' };
        }

        // Get game details
        const universeResponse = await fetch(
            `https://games.roblox.com/v1/games?universeIds=${presence.universeId}`
        );
        
        let gameName = 'Unknown Game';
        if (universeResponse.ok) {
            const universeData = await universeResponse.json();
            if (universeData.data && universeData.data.length > 0) {
                gameName = universeData.data[0].name;
            }
        }

        // Get server join script
        let joinScript = '';
        if (gameId) {
            const serverResponse = await fetch(
                `https://games.roblox.com/v1/games/${placeId}/servers/${gameId}`
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
        console.error('Roblox presence fetch error:', error);
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
    let regionLabel = null;   // human-readable "City, Country" of the server
    let regionSource = null;  // 'RoValra' | 'ip-api' | null

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

    // Resolve the hosting server's IP / data-center via the gamejoin API
    if (presence.serverId && presence.placeId) {
        try {
            const { getServerIp } = require('./robloxAuth');
            const ipResult = await getServerIp(presence.placeId, presence.serverId);
            if (ipResult && (ipResult.machineAddress || ipResult.dataCenterId)) {
                const { resolveRoValraDatacenterRegion, geolocateIp, normalizeCountryToRegion, normalizeCountryCodeToRegion } = require('./regionMap');
                let resolved = null;      // normalized region code (or raw label)
                let resolvedLabel = null; // human-readable "City, Country"
                let source = null;

                // 1) RoValra FIRST — its public datacenter list gives the EXACT
                //    country for the server's dataCenterId (no IP guessing).
                try {
                    const rovalra = await resolveRoValraDatacenterRegion(ipResult.dataCenterId);
                    if (rovalra && (rovalra.region || rovalra.countryCode)) {
                        resolved = rovalra.region || null;
                        detectedCountryCode = rovalra.countryCode || null;
                        resolvedLabel = rovalra.label || null;
                        source = 'RoValra';
                    }
                } catch (err) { /* fall through to ip-api */ }

                // 2) ip-api.com fallback when RoValra had no hit / failed.
                if (!resolved && (ipResult.publicAddress || ipResult.machineAddress)) {
                    try {
                        const geo = await geolocateIp(ipResult.publicAddress || ipResult.machineAddress);
                        if (geo) {
                            resolved = normalizeCountryToRegion(geo.country)
                                || normalizeCountryCodeToRegion(geo.countryCode)
                                || geo.label; // last resort: raw "City, Region, Country" label
                            detectedCountryCode = geo.countryCode || null;
                            resolvedLabel = geo.label;
                            source = 'ip-api';
                        }
                    } catch (err) { /* both failed -> 'Unknown' below */ }
                }

                detectedRegion = resolved || 'Unknown'; // both live services failed
                regionLabel = resolvedLabel;
                regionSource = source;
                console.log('Resolved region:', detectedRegion, 'country:', detectedCountryCode || '-',
                    '(source:', source || 'unknown', resolvedLabel ? '| ' + resolvedLabel : '', ')');
            }
        } catch (err) {
            console.error('gamejoin region lookup failed:', err);
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

    // Fetch the Roblox game icon (thumbnail) to render as the embed's media image.
    let gameIconUrl = '';
    if (presence.universeId) {
        try {
            const thumbResponse = await fetch(
                `https://thumbnails.roblox.com/v1/games/icons?universeIds=${presence.universeId}&size=512x512&format=Png&isCircular=false`
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
