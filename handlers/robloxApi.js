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

module.exports = {
    validateRobloxUser,
    getRobloxAvatarUrl,
    validateAndGetAvatar
};