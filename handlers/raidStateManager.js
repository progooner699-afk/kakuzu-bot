const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const leaderboardDb = require('./leaderboardDb');
const robloxApi = require('./robloxApi');

const baseDataDir = path.join(__dirname, '..', 'data');
const guildsDataDir = path.join(baseDataDir, 'guilds');

const defaultSettings = {
    raidChannel: null,
    helpChannel: null,
    leaderboardChannel: null,
    leaderboardMessageId: null,
    resultChannel: null,
    infoChannel: null,
    lockedPingRoleId: null,
    // Dedicated pending verifications log channel (per guild, persistent)
    verificationLogsChannel: null,
    verificationResultChannel: null,
    // Role IDs allowed to accept/reject verifications (per guild, persistent)
    verificationAdminRoles: [],
    // Persistent per-guild counter used to generate unique verification IDs
    verificationRequestCounter: 0,
    // regionPings: mapping of normalized region -> array of role IDs (strings)
    regionPings: {},
    // Channel where the official /link-roblox verification embed lives. Used to
    // dynamically point unverified users to the correct channel in guard messages.
    verificationChannel: null
};

const defaultRaids = {
    lastRaidId: 0,
    raids: [],
    activeRaidByOwner: {},
    blacklist: {},
    streakType: 'NONE',
    streakCount: 0,
    leaderboard: {
        daily: {},
        weekly: {},
        allTime: {},
        dailyReset: 0,
        weeklyReset: 0
    }
};

const profileCache = new Map();
const PROFILE_CACHE_TTL = 10 * 60 * 1000;

/**
 * Game selection configuration used throughout the raid pipeline.
 * The key is the stored value on the raid object; the value is the
 * display label (emoji + name) shown in embeds and UI.
 */
const GAME_CONFIG = {
    'tsb': '🥊 The Strongest Battlegrounds',
    'rivals': '⚔️ RIVALS',
    'bedwars': '🛏️ BedWars',
    'bloxfuits': '🍎 Blox Fruits',
    'jjk': '👁️ JJK'
};

/**
 * Formats a number of seconds into a human-readable duration string.
 * e.g. 860 → "14m 20s"
 */
function formatTimeSpent(totalSeconds) {
    if (!totalSeconds || totalSeconds < 0) totalSeconds = 0;
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}m ${s}s`;
}

function getGuildDataDir(guildId) {
    return path.join(guildsDataDir, guildId);
}

function getSettingsPath(guildId) {
    return path.join(getGuildDataDir(guildId), 'settings.json');
}

function getRaidsPath(guildId) {
    return path.join(getGuildDataDir(guildId), 'raids.json');
}

function ensureDataFiles() {
    if (!fs.existsSync(baseDataDir)) {
        fs.mkdirSync(baseDataDir, { recursive: true });
    }
    if (!fs.existsSync(guildsDataDir)) {
        fs.mkdirSync(guildsDataDir, { recursive: true });
    }
}

function ensureGuildDataFiles(guildId) {
    ensureDataFiles();
    const guildDir = getGuildDataDir(guildId);
    if (!fs.existsSync(guildDir)) {
        fs.mkdirSync(guildDir, { recursive: true });
    }
    const settingsPath = getSettingsPath(guildId);
    const raidsPath = getRaidsPath(guildId);
    if (!fs.existsSync(settingsPath)) {
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
    }
    if (!fs.existsSync(raidsPath)) {
        fs.writeFileSync(raidsPath, JSON.stringify(defaultRaids, null, 4));
    }
}

function loadSettings(guildId) {
    ensureGuildDataFiles(guildId);
    const raw = fs.readFileSync(getSettingsPath(guildId), 'utf8');
    const settings = JSON.parse(raw);
    return Object.assign({}, defaultSettings, settings);
}

function saveSettings(guildId, settings) {
    fs.writeFileSync(getSettingsPath(guildId), JSON.stringify(settings, null, 4));
}

/**
 * Generates the next unique verification request ID for a guild, e.g. VER-0001.
 * The counter is persisted per-guild in settings.json so IDs survive restarts
 * and are unique across all verification requests in the same guild.
 */
function getNextVerificationId(guildId) {
    const settings = loadSettings(guildId);
    const next = (Number(settings.verificationRequestCounter) || 0) + 1;
    settings.verificationRequestCounter = next;
    saveSettings(guildId, settings);
    return `VER-${String(next).padStart(4, '0')}`;
}

function loadRaids(guildId) {
    ensureGuildDataFiles(guildId);
    const raw = fs.readFileSync(getRaidsPath(guildId), 'utf8');
    const raids = JSON.parse(raw);
    raids.leaderboard = Object.assign({}, defaultRaids.leaderboard, raids.leaderboard || {});
    raids.activeRaidByOwner = Object.assign({}, defaultRaids.activeRaidByOwner, raids.activeRaidByOwner || {});
    const loadedRaids = Object.assign({}, defaultRaids, raids);
    rebuildActiveRaidByOwner(loadedRaids);
    return loadedRaids;
}

function saveRaids(guildId, raids) {
    fs.writeFileSync(getRaidsPath(guildId), JSON.stringify(raids, null, 4));
}

function rebuildActiveRaidByOwner(raids) {
    raids.activeRaidByOwner = {};
    for (const raid of raids.raids) {
        if (raid.requesterId && raid.status && raid.status !== 'CLOSED') {
            raids.activeRaidByOwner[raid.requesterId] = raid.raidId;
        }
    }
}

function getActiveRaidByOwner(userId, guildId) {
    const raids = loadRaids(guildId);
    const raidId = raids.activeRaidByOwner[userId];
    if (raidId) {
        return raids.raids.find(item => item.raidId === raidId) || null;
    }
    return raids.raids.find(raid => raid.requesterId === userId && raid.status !== 'CLOSED') || null;
}

function hasActiveRaid(userId, guildId) {
    return Boolean(getActiveRaidByOwner(userId, guildId));
}

function getNextDailyReset() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    return next.getTime();
}

function getNextWeeklyReset() {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = ((8 - day) % 7) || 7;
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff, 0, 0, 0, 0));
    return next.getTime();
}

function resetLeaderboardsIfNeeded(raids) {
    const now = Date.now();
    if (!raids.leaderboard.dailyReset || now >= raids.leaderboard.dailyReset) {
        raids.leaderboard.daily = {};
        raids.leaderboard.dailyReset = getNextDailyReset();
    }
    if (!raids.leaderboard.weeklyReset || now >= raids.leaderboard.weeklyReset) {
        raids.leaderboard.weekly = {};
        raids.leaderboard.weeklyReset = getNextWeeklyReset();
    }
}

function normalizeText(input) {
    return String(input || '').trim();
}

function getTeamersCount(teamers) {
    if (!teamers) return 0;
    return teamers.split(',').map(item => item.trim()).filter(Boolean).length;
}

function parseBooleanYesNo(value) {
    const normalized = normalizeText(value).toLowerCase();
    if (['yes', 'y', 'true'].includes(normalized)) return 'YES';
    if (['no', 'n', 'false'].includes(normalized)) return 'NO';
    return 'NO';
}

function canCreateRaid(userId, guildId) {
    return !hasActiveRaid(userId, guildId) && !isBlacklisted(userId, guildId);
}

function isBlacklisted(userId, guildId) {
    const raids = loadRaids(guildId);
    return Boolean(raids.blacklist[userId]);
}

function blacklistUser(userId, reason = 'Misuse of raid system', guildId) {
    const raids = loadRaids(guildId);
    raids.blacklist[userId] = { reason, timestamp: Date.now() };
    saveRaids(guildId, raids);
}

function createRaid(options) {
    const isDraft = options.draft === true;
    if (!isDraft && !canCreateRaid(options.requesterId, options.guildId)) {
        throw new Error('User already has an active raid or is blocked from creating new raids.');
    }
    const raids = loadRaids(options.guildId);
    if (!isDraft) resetLeaderboardsIfNeeded(raids);
    const nextId = raids.lastRaidId + 1;
    const teamersCount = getTeamersCount(options.teamers);
        const raid = {
        raidId: nextId,
        status: isDraft ? 'PENDING' : 'OPEN',
        requesterId: options.requesterId,
        requesterTag: options.requesterTag,
        targetGame: normalizeText(options.targetGame || ''),
        robloxUsername: normalizeText(options.robloxUsername),
        robloxDisplayName: normalizeText(options.robloxDisplayName || options.robloxUsername),
        robloxUserId: options.robloxUserId || "1",
        robloxAvatarUrl: options.robloxAvatarUrl || null,
        serverLink: normalizeText(options.serverLink),
        placeId: normalizeText(options.placeId),
        serverId: normalizeText(options.serverId),
        gameThumbnailUrl: normalizeText(options.gameThumbnailUrl),
        region: normalizeText(options.region),
        enemyCount: Number(options.enemyCount) || 0,
        teamers: normalizeText(options.teamers),
        teamersCount,
        enemyClanNames: normalizeText(options.enemyClanNames),
        enemyNames: normalizeText(options.enemyNames),
        enemyClanPresent: parseBooleanYesNo(options.enemyClanPresent),
        reason: normalizeText(options.reason),
        helperLimit: Number(options.helperLimit) || 1,
        helpers: [],
        messageId: null,
        channelId: null,
        createdAt: Date.now()
    };
    raids.lastRaidId = nextId;
    raids.raids.push(raid);
    if (!isDraft && raid.requesterId) {
        raids.activeRaidByOwner[raid.requesterId] = raid.raidId;
    }
    saveRaids(options.guildId, raids);
    return raid;
}

function getRaidById(raidId, guildId) {
    const raids = loadRaids(guildId);
    return raids.raids.find(raid => raid.raidId === raidId) || null;
}

function updateRaidStatus(raid) {
    if (!raid || raid.status === 'CLOSED') return raid;
    raid.status = raid.helpers.length >= raid.helperLimit ? 'FULL' : 'OPEN';
    return raid;
}

async function addHelper(raidId, userId, robloxData, guildId) {
    const raids = loadRaids(guildId);
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid || raid.status === 'CLOSED') return { success: false, message: 'Raid is closed.' };
    
    const isAlreadyHelping = raid.helpers.some(h => typeof h === 'string' ? h === userId : h.userId === userId);
    if (isAlreadyHelping) return { success: false, message: 'You are already helping this raid.' };
    if (await leaderboardDb.hasAcceptedRaid(raidId, userId, guildId)) return { success: false, message: 'You have already accepted this raid alert.' };
    if (raid.helpers.length >= raid.helperLimit) return { success: false, message: 'Raid is already full.' };
    
        raid.helpers.push({
        userId: userId,
        robloxUsername: robloxData.username,
        robloxDisplayName: robloxData.displayName,
        robloxUserId: robloxData.userId,
        joinTime: Date.now(),
        timeSpentSeconds: 0
    });
    
    updateRaidStatus(raid);
    saveRaids(guildId, raids);
    const totalRaids = await leaderboardDb.incrementRaidCount(userId, guildId);
    await leaderboardDb.markRaidAccepted(raidId, userId, guildId);
    return { success: true, raid, totalRaids };
}

function removeHelper(raidId, userId, guildId) {
    const raids = loadRaids(guildId);
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid || raid.status === 'CLOSED') return { success: false, message: 'Raid is closed.' };
    
    const index = raid.helpers.findIndex(h => typeof h === 'string' ? h === userId : h.userId === userId);
    if (index === -1) return { success: false, message: 'You are not a helper on this raid.' };
    
    raid.helpers.splice(index, 1);
    updateRaidStatus(raid);
    saveRaids(guildId, raids);
    return { success: true, raid };
}

function closeRaid(raidId, options = {}, guildId) {
    const raids = loadRaids(guildId);
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return null;
    raid.status = 'CLOSED';
    raid.outcome = options.outcome || null;
    raid.mvpUserId = options.mvpUserId || null;
    raid.closedBy = options.closedBy || null;
    raid.closedByTag = options.closedByTag || null;
    raid.closeReason = options.closeReason || null;
    raid.closedAt = Date.now();

    // Stop timers for all helpers: calculate elapsed time from joinTime (or
    // lastSeenTime if presence polling updated it) to now.
    for (const helper of raid.helpers) {
        if (typeof helper === 'object' && helper.userId) {
            if (helper.lastSeenTime) {
                // Helper was tracked as in-game by the presence poller
                const elapsed = Math.floor((Date.now() - helper.lastSeenTime) / 1000);
                helper.timeSpentSeconds = (helper.timeSpentSeconds || 0) + elapsed;
                helper.lastSeenTime = null;
            } else if (!helper.timeSpentSeconds || helper.timeSpentSeconds === 0) {
                // Fallback: simple join-to-close delta
                const joinTime = helper.joinTime || raid.createdAt;
                helper.timeSpentSeconds = Math.floor((Date.now() - joinTime) / 1000);
            }
        }
    }

    if (raids.activeRaidByOwner[raid.requesterId] === raid.raidId) {
        delete raids.activeRaidByOwner[raid.requesterId];
    }
    saveRaids(guildId, raids);
    return raid;
}

function closeAllRaids(guildId) {
    const raids = loadRaids(guildId);
    let closedCount = 0;

    for (const raid of raids.raids) {
        if (raid.status !== 'CLOSED') {
            raid.status = 'CLOSED';
            closedCount += 1;
        }
    }

    raids.activeRaidByOwner = {};
    saveRaids(guildId, raids);
    return closedCount;
}

function updateRaidMessageReference(raidId, channelId, messageId, guildId) {
    const raids = loadRaids(guildId);
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return;
    raid.channelId = channelId;
    raid.messageId = messageId;
    saveRaids(guildId, raids);
}

function formatRaidMessage(raid, guildId = null) {
    const helperCount = (raid.helpers && raid.helpers.length) || 0;
    const alertStateWord = raid.status === 'CLOSED' ? 'CLOSED' : (raid.status === 'FULL' ? 'FULL' : 'ACTIVE');
    const statusEmoji = raid.status === 'CLOSED' ? '🔴' : (raid.status === 'FULL' ? '🟠' : '🟢');
    const statusText = raid.status === 'CLOSED' ? 'Closed' : (raid.status === 'FULL' ? 'Full' : 'Open');
    const reasonText = raid.reason ? raid.reason : 'No details provided';
    const gameLabel = GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';
    const requestedBy = raid.requesterTag ? raid.requesterTag : `<@${raid.requesterId}>`;
    const createdMs = Number(raid.createdAt) || Date.now();
    const createdTs = Math.floor(createdMs / 1000);

    // Current win/loss streak from the per-guild lobby data (when guild id is known).
    let streakText = '—';
    if (guildId) {
        try {
            const raids = loadRaids(guildId);
            if (raids.streakType && Number(raids.streakCount) > 0) {
                streakText = `${raids.streakType === 'WIN' ? '🏆' : '💀'} ${raids.streakCount} consecutive ${raids.streakType.toLowerCase()}`;
            }
        } catch (err) { /* ignore */ }
    }

    // Discord renders only ONE thumbnail + ONE image per embed, so we cannot tile
    // each helper's Roblox headshot inline next to their name. Helpers are listed as
    // a compact mention + Roblox name row with their accumulated session time.
    const liveHelpersValue = helperCount > 0
        ? raid.helpers.map((h) => {
            if (typeof h === 'string') return `• <@${h}>`;
            const helperName = h.robloxDisplayName || h.robloxUsername || `<@${h.userId}>`;
            const timeSpent = (h && h.timeSpentSeconds) ? ` ⏱️ ${formatTimeSpent(h.timeSpentSeconds)}` : '';
            return `• <@${h.userId}> (${helperName})${timeSpent}`;
        }).join('\n')
        : '• *None active... waiting for helpers to join*';

    const embed = new EmbedBuilder()
        .setTitle(`# 🚨 Raid Alert #${raid.raidId}`)
        .setColor(0xFFD700)
        .setDescription(`**This alert is currently ${alertStateWord}.** <t:${createdTs}:F>\n\n---`)
        .setFooter({ text: `Requested by ${requestedBy} • ${new Date(createdMs).toLocaleString()}` });

    // Roblox PFP of the raid requester — top-right thumbnail.
    if (raid.robloxAvatarUrl) {
        embed.setThumbnail(raid.robloxAvatarUrl);
    }

    // Roblox game artwork banner — large bottom media image.
    if (raid.gameThumbnailUrl) {
        embed.setImage(raid.gameThumbnailUrl);
    }

    embed.addFields([
        { name: '👤 Requested By', value: requestedBy, inline: true },
        { name: '🕒 Time Requested', value: `<t:${createdTs}:F>`, inline: true },
        { name: '📌 Status / Game', value: `${statusEmoji} ${statusText} | ${gameLabel}`, inline: true },
        { name: '🎯 Target Info', value: `\`\`\`\nEnemy Clan: ${raid.enemyClanNames || 'None'}\nTargets: ${raid.enemyNames || 'None'}\n\`\`\``, inline: true },
        { name: '🌐 Server Info', value: `\`\`\`\nRegion: ${raid.region || 'Unknown'} | Ping: N/Ams\nWin Streak: ${streakText}\n\`\`\``, inline: true },
        { name: `👥 Live Helpers (${helperCount}/${raid.helperLimit || 0})`, value: liveHelpersValue, inline: false },
        { name: '💬 Additional Details & Reason', value: `\`\`\`\n${reasonText}\n\`\`\``, inline: false }
    ]);

    return embed;
}
function setRaidMvp(raidId, mvpUserId, guildId) {
    const raids = loadRaids(guildId);
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return null;
    raid.mvpUserId = mvpUserId;
    saveRaids(guildId, raids);
    return raid;
}

async function pollHelperPresences(client, guildId) {
    const apiKey = process.env.ROBLOX_API_KEY;
    if (!apiKey) return;
    const raids = loadRaids(guildId);
    const activeRaids = raids.raids.filter(r => r.status !== 'CLOSED' && Array.isArray(r.helpers) && r.helpers.length > 0);
    if (activeRaids.length === 0) return;
    const helperUserIds = [];
    const helperMap = new Map();
    for (const raid of activeRaids) {
        for (const helper of raid.helpers) {
            if (typeof helper === 'object' && helper.robloxUserId && helper.robloxUserId !== '1') {
                helperUserIds.push(helper.robloxUserId);
                helperMap.set(helper.robloxUserId, { raid, helper });
            }
        }
    }
    if (helperUserIds.length === 0) return;
    try {
        const response = await fetch('https://presence.roblox.com/v1/presence/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
            body: JSON.stringify({ userIds: helperUserIds })
        });
        if (!response.ok) return;
        const data = await response.json();
        for (const user of (data.userPresences || data.data || [])) {
            const info = helperMap.get(String(user.userId));
            if (!info) continue;
            const helper = info.helper;
            if (user.userPresenceType === 'InGame' && !helper.lastSeenTime) {
                helper.lastSeenTime = Date.now();
            } else if (user.userPresenceType !== 'InGame' && helper.lastSeenTime) {
                const elapsed = Math.floor((Date.now() - helper.lastSeenTime) / 1000);
                helper.timeSpentSeconds = (helper.timeSpentSeconds || 0) + elapsed;
                helper.lastSeenTime = null;
            }
        }
        saveRaids(guildId, raids);
    } catch (error) {
        console.warn('Presence polling error:', error?.message || error);
    }
}

function getTopEntries(ranking, max = 5) {
    return Object.entries(ranking)
        .sort((a, b) => b[1] - a[1])
        .slice(0, max);
}

function getRaidProfileContext(userId, guildId) {
    const raids = loadRaids(guildId);
    for (const raid of raids.raids) {
        if (raid.requesterId === userId) {
            if (raid.robloxDisplayName || raid.robloxUserId) {
                return {
                    robloxDisplayName: raid.robloxDisplayName || 'Not Linked',
                    robloxUserId: raid.robloxUserId || null,
                    robloxUsername: raid.robloxUsername || null
                };
            }
        }

        if (Array.isArray(raid.helpers)) {
            const helper = raid.helpers.find(item => {
                if (typeof item === 'string') return item === userId;
                return item && item.userId === userId;
            });
            if (helper) {
                return {
                    robloxDisplayName: helper.robloxDisplayName || helper.robloxUsername || 'Not Linked',
                    robloxUserId: helper.robloxUserId || null,
                    robloxUsername: helper.robloxUsername || null
                };
            }
        }
    }
    return null;
}

async function getLeaderboardUserProfile(client, userId, guildId) {
    const cacheKey = `${guildId}:${userId}`;
    const cached = profileCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL) {
        return cached;
    }

    let discordUser = null;
    try {
        discordUser = await client.users.fetch(userId).catch(() => null);
    } catch (error) {
        console.error('Failed to fetch Discord user for leaderboard:', error);
    }

    const context = getRaidProfileContext(userId, guildId);
    let robloxDisplayName = 'Not Linked';
    let robloxUserId = null;
    let avatarUrl = null;

    if (context?.robloxUserId) {
        robloxUserId = context.robloxUserId;
        robloxDisplayName = context.robloxDisplayName || robloxDisplayName;
    } else if (context?.robloxUsername) {
        const validation = await robloxApi.validateRobloxUser(context.robloxUsername).catch(() => null);
        if (validation?.success) {
            robloxUserId = validation.userId;
            robloxDisplayName = validation.displayName || context.robloxDisplayName || 'Not Linked';
        }
    }

    if (robloxUserId) {
        const avatarResult = await robloxApi.getRobloxAvatarUrl(robloxUserId).catch(() => null);
        if (avatarResult?.success) {
            avatarUrl = avatarResult.avatarUrl;
        }
    }

    const profile = {
        userId,
        discordMention: discordUser ? `<@${userId}>` : 'Unknown User',
        discordName: discordUser?.displayName || discordUser?.username || 'Unknown User',
        robloxDisplayName,
        robloxUserId,
        avatarUrl,
        fetchedAt: Date.now()
    };

    profileCache.set(userId, profile);
    return profile;
}

async function buildLeaderboardEmbed(client, topEntries, guildId) {
    const embed = new EmbedBuilder()
        .setTitle('🏆 Raid Leaderboard')
        .setDescription('Top 20 Most Active Raiders')
        .setColor(0x00AEEF)
        .setFooter({ text: 'Updates Automatically' })
        .setTimestamp();

    if (!Array.isArray(topEntries) || topEntries.length === 0) {
        embed.setDescription('Top 20 Most Active Raiders\n\n• No raid data tracked yet.');
        return embed;
    }

    const sections = [];
    for (let index = 0; index < Math.min(topEntries.length, 20); index += 1) {
        const entry = topEntries[index];
        const rank = index + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏅';
        const profile = await getLeaderboardUserProfile(client, entry.userId, guildId);
        const discordLabel = profile.discordMention || profile.discordName || 'Unknown User';
        const robloxLabel = profile.robloxDisplayName || 'Not Linked';
        const avatarLine = profile.avatarUrl
            ? `🖼️ Roblox Avatar: [Open Avatar](${profile.avatarUrl})`
            : '🖼️ Roblox Avatar: Default Clan Avatar';

        sections.push(
            [
                '━━━━━━━━━━━━━━━━━━',
                `${medal} **Rank #${rank}**`,
                `👤 **Discord:** ${discordLabel}`,
                `🎮 **Roblox:** ${robloxLabel}`,
                `⚔️ **Raids:** **${entry.raidCount || 0}**`,
                avatarLine,
                ''
            ].join('\n')
        );
    }

    const rankOneProfile = sections.length > 0 ? await getLeaderboardUserProfile(client, topEntries[0].userId, guildId) : null;
    if (rankOneProfile?.avatarUrl) {
        embed.setThumbnail(rankOneProfile.avatarUrl);
    } else if (client?.user?.displayAvatarURL) {
        embed.setThumbnail(client.user.displayAvatarURL({ size: 256 }));
    }

    embed.setDescription(`Top 20 Most Active Raiders\n\n${sections.join('\n')}`);
    return embed;
}

async function buildLeaderboardEmbeds(client, topEntries = null, guildId) {
    const entries = topEntries || await leaderboardDb.getTopLeaderboard(20, guildId);
    return [await buildLeaderboardEmbed(client, entries, guildId)];
}

async function publishLeaderboard(client, guildId) {
    const settings = loadSettings(guildId);
    if (!settings.leaderboardChannel) return;

    const channel = await client.channels.fetch(settings.leaderboardChannel).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    
    const topEntries = await leaderboardDb.getTopLeaderboard(20, guildId);
    const embeds = await buildLeaderboardEmbeds(client, topEntries, guildId);
    
    if (settings.leaderboardMessageId) {
        const existing = await channel.messages.fetch(settings.leaderboardMessageId).catch(() => null);
        if (existing) {
            try {
                await existing.edit({ embeds });
                return;
            } catch (error) {
                if (error?.code === 10008) {
                    settings.leaderboardMessageId = null;
                    saveSettings(guildId, settings);
                } else {
                    throw error;
                }
            }
        } else {
            settings.leaderboardMessageId = null;
            saveSettings(guildId, settings);
        }
    }
    
    const message = await channel.send({ embeds });
    settings.leaderboardMessageId = message.id;
    saveSettings(guildId, settings);
}

async function syncLeaderboardMessage(client, guildId) {
    await publishLeaderboard(client, guildId);
}

// Mark a previously-drafted (PENDING) raid as genuinely open. This is only
// invoked AFTER the raid alert embed has actually been posted to the channel,
// so a raid is never considered open until real helpers can see it.
function setRaidOpen(raidId, guildId) {
    const raids = loadRaids(guildId);
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return null;
    raid.status = 'OPEN';
    if (raid.requesterId) raids.activeRaidByOwner[raid.requesterId] = raidId;
    saveRaids(guildId, raids);
    return raid;
}

// Remove any raids this requester still has in the PENDING/draft state (e.g.
// from an interrupted run that never posted its alert embed). This lets the
// user retry without hitting a stale "already open raid" error.
function cleanupPendingRaids(userId, guildId) {
    const raids = loadRaids(guildId);
    const before = raids.raids.length;
    raids.raids = raids.raids.filter(r => !(r.status === 'PENDING' && r.requesterId === userId));
    if (raids.raids.length !== before) saveRaids(guildId, raids);
}

module.exports = {
    ensureDataFiles,
    loadSettings,
    saveSettings,
    getNextVerificationId,
    loadRaids,
    saveRaids,
    canCreateRaid,
    isBlacklisted,
    blacklistUser,
    createRaid,
    setRaidOpen,
    cleanupPendingRaids,
    getRaidById,
    addHelper,
    removeHelper,
    closeRaid,
    updateRaidMessageReference,
    formatRaidMessage,
    publishLeaderboard,
    syncLeaderboardMessage,
    closeAllRaids,
    buildLeaderboardEmbeds,
    formatTimeSpent,
    GAME_CONFIG,
    setRaidMvp,
    pollHelperPresences
};