function formatRobloxProfileValue(verificationData = {}) {
  const displayName = verificationData.roblox_display_name || verificationData.robloxDisplayName || verificationData.roblox_username || verificationData.robloxUsername || 'Unknown';
  const username = verificationData.roblox_username || verificationData.robloxUsername || null;
  const userId = verificationData.roblox_user_id || verificationData.robloxUserId || null;

  const usernameSuffix = username ? ` (@${username})` : '';

  if (!userId) {
    return `${displayName}${usernameSuffix}`;
  }

  const profileLink = `https://www.roblox.com/users/${userId}/profile`;
  return `[${displayName}${usernameSuffix}](${profileLink})`;
}

module.exports = {
  formatRobloxProfileValue
};
