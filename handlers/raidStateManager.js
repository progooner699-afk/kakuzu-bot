const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const leaderboardDb = require('./leaderboardDb');
const robloxApi = require('./robloxApi');

const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
const raidsPath = path.join(__dirname, '..', 'data', 'raids.json');

const defaultSettings = {
    raidChannel: null,
    helpChannel: null,
    leaderboardChannel: null, 
    leaderboardMessageId: null,
    resultChannel: null
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

function ensureDataFiles() {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(settingsPath)) {
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
    }
    if (!fs.existsSync(raidsPath)) {
        fs.writeFileSync(raidsPath, JSON.stringify(defaultRaids, null, 4));
    }
}

function loadSettings() {
    ensureDataFiles();
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    return Object.assign({}, defaultSettings, settings);
}

function saveSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

function loadRaids() {
    ensureDataFiles();
    const raw = fs.readFileSync(raidsPath, 'utf8');
    const raids = JSON.parse(raw);
    raids.leaderboard = Object.assign({}, defaultRaids.leaderboard, raids.leaderboard || {});
    raids.activeRaidByOwner = Object.assign({}, defaultRaids.activeRaidByOwner, raids.activeRaidByOwner || {});
    const loadedRaids = Object.assign({}, defaultRaids, raids);
    rebuildActiveRaidByOwner(loadedRaids);
    return loadedRaids;
}

function saveRaids(raids) {
    fs.writeFileSync(raidsPath, JSON.stringify(raids, null, 4));
}

function rebuildActiveRaidByOwner(raids) {
    raids.activeRaidByOwner = {};
    for (const raid of raids.raids) {
        if (raid.requesterId && raid.status && raid.status !== 'CLOSED') {
            raids.activeRaidByOwner[raid.requesterId] = raid.raidId;
        }
    }
}

function getActiveRaidByOwner(userId) {
    const raids = loadRaids();
    const raidId = raids.activeRaidByOwner[userId];
    if (raidId) {
        return raids.raids.find(item => item.raidId === raidId) || null;
    }
    return raids.raids.find(raid => raid.requesterId === userId && raid.status !== 'CLOSED') || null;
}

function hasActiveRaid(userId) {
    return Boolean(getActiveRaidByOwner(userId));
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

function canCreateRaid(userId) {
    return !hasActiveRaid(userId) && !isBlacklisted(userId);
}

function isBlacklisted(userId) {
    const raids = loadRaids();
    return Boolean(raids.blacklist[userId]);
}

function blacklistUser(userId, reason = 'Misuse of raid system') {
    const raids = loadRaids();
    raids.blacklist[userId] = { reason, timestamp: Date.now() };
    saveRaids(raids);
}

function createRaid(options) {
    if (!canCreateRaid(options.requesterId)) {
        throw new Error('User already has an active raid or is blocked from creating new raids.');
    }
    const raids = loadRaids();
    resetLeaderboardsIfNeeded(raids);
    const nextId = raids.lastRaidId + 1;
    const teamersCount = getTeamersCount(options.teamers);
    const raid = {
        raidId: nextId,
        status: 'OPEN',
        requesterId: options.requesterId,
        requesterTag: options.requesterTag,
        robloxUsername: normalizeText(options.robloxUsername),
        robloxDisplayName: normalizeText(options.robloxDisplayName || options.robloxUsername),
        robloxUserId: options.robloxUserId || "1",
        robloxAvatarUrl: options.robloxAvatarUrl || null,
        serverLink: normalizeText(options.serverLink),
        region: normalizeText(options.region),
        enemyCount: Number(options.enemyCount) || 0,
        teamers: normalizeText(options.teamers),
        teamersCount,
        enemyClanNames: normalizeText(options.enemyClanNames),
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
    raids.activeRaidByOwner[raid.requesterId] = raid.raidId;
    saveRaids(raids);
    return raid;
}

function getRaidById(raidId) {
    const raids = loadRaids();
    return raids.raids.find(raid => raid.raidId === raidId) || null;
}

function updateRaidStatus(raid) {
    if (!raid || raid.status === 'CLOSED') return raid;
    raid.status = raid.helpers.length >= raid.helperLimit ? 'FULL' : 'OPEN';
    return raid;
}

async function addHelper(raidId, userId, robloxData) {
    const raids = loadRaids();
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid || raid.status === 'CLOSED') return { success: false, message: 'Raid is closed.' };
    
    const isAlreadyHelping = raid.helpers.some(h => typeof h === 'string' ? h === userId : h.userId === userId);
    if (isAlreadyHelping) return { success: false, message: 'You are already helping this raid.' };
    if (await leaderboardDb.hasAcceptedRaid(raidId, userId)) return { success: false, message: 'You have already accepted this raid alert.' };
    if (raid.helpers.length >= raid.helperLimit) return { success: false, message: 'Raid is already full.' };
    
    raid.helpers.push({
        userId: userId,
        robloxUsername: robloxData.username,
        robloxDisplayName: robloxData.displayName,
        robloxUserId: robloxData.userId
    });
    
    updateRaidStatus(raid);
    saveRaids(raids);
    const totalRaids = await leaderboardDb.incrementRaidCount(userId);
    await leaderboardDb.markRaidAccepted(raidId, userId);
    return { success: true, raid, totalRaids };
}

function removeHelper(raidId, userId) {
    const raids = loadRaids();
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid || raid.status === 'CLOSED') return { success: false, message: 'Raid is closed.' };
    
    const index = raid.helpers.findIndex(h => typeof h === 'string' ? h === userId : h.userId === userId);
    if (index === -1) return { success: false, message: 'You are not a helper on this raid.' };
    
    raid.helpers.splice(index, 1);
    updateRaidStatus(raid);
    saveRaids(raids);
    return { success: true, raid };
}

function closeRaid(raidId, options = {}) {
    const raids = loadRaids();
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return null;
    raid.status = 'CLOSED';
    raid.closedBy = options.closedBy || null;
    raid.closedByTag = options.closedByTag || null;
    raid.closeReason = options.closeReason || null;
    raid.closedAt = Date.now();
    if (raids.activeRaidByOwner[raid.requesterId] === raid.raidId) {
        delete raids.activeRaidByOwner[raid.requesterId];
    }
    saveRaids(raids);
    return raid;
}

function closeAllRaids() {
    const raids = loadRaids();
    let closedCount = 0;

    for (const raid of raids.raids) {
        if (raid.status !== 'CLOSED') {
            raid.status = 'CLOSED';
            closedCount += 1;
        }
    }

    raids.activeRaidByOwner = {};
    saveRaids(raids);
    return closedCount;
}

function updateRaidMessageReference(raidId, channelId, messageId) {
    const raids = loadRaids();
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return;
    raid.channelId = channelId;
    raid.messageId = messageId;
    saveRaids(raids);
}

function formatRaidMessage(raid) {
    const helperCount = (raid.helpers && raid.helpers.length) || 0;
    const statusText = raid.status === 'OPEN' ? '🟢 `OPEN`' : raid.status === 'FULL' ? '🟠 `FULL`' : '🔴 `CLOSED`';
    const reasonText = raid.reason ? raid.reason : 'No details provided';

    const liveHelpersValue = helperCount > 0 
        ? raid.helpers.map((h) => {
            if (typeof h === 'string') return `• <@${h}>`;
            return `• <@${h.userId}>\n  🎮 Roblox: [👑 ${h.robloxDisplayName} (@${h.robloxUsername})](https://www.roblox.com/users/${h.robloxUserId}/profile)`;
          }).join('\n') 
        : '• None yet';

    const requesterProfileLink = raid.robloxUserId 
        ? `\n[🔗 ${raid.robloxDisplayName || raid.robloxUsername} Profile](https://www.roblox.com/users/${raid.robloxUserId}/profile)`
        : '';

    const embed = new EmbedBuilder()
        .setTitle('🚨 Raid Alert')
        .setColor(0xFFD700)
        .setDescription('This help request is currently active.')
        .addFields([
            { name: 'Requested By', value: `${raid.requesterTag || `<@${raid.requesterId}>`}${requesterProfileLink}`, inline: true },
            { name: 'Time Requested', value: `\`${new Date(raid.createdAt).toLocaleString()}\``, inline: true },
            { name: 'Region', value: `\`${raid.region || 'Unknown'}\``, inline: true },
            { name: '\u200b', value: '\u200b', inline: false },
            { name: 'Enemy Count', value: `\`${raid.enemyCount || 0}\``, inline: true },
            { name: 'Helpers Needed', value: `\`${helperCount} / ${raid.helperLimit || 0}\``, inline: true },
            { name: 'Live Status', value: statusText, inline: true },
            { name: '\u200b', value: '\u200b', inline: false },
            { name: 'Teamers Names', value: raid.teamers ? `\`${raid.teamers}\`` : '`None`', inline: true },
            { name: 'Enemy Clan Names', value: raid.enemyClanNames ? `\`${raid.enemyClanNames}\`` : '`None`', inline: true },
            { name: '\u200b', value: '\u200b', inline: false },
            { name: 'Reason & Additional Details', value: `\`\`\`text\n${reasonText}\n\`\`\``, inline: false },
            { name: '\u200b', value: '\u200b', inline: false },
            { name: `Live Helpers (${helperCount}/${raid.helperLimit || 0})`, value: liveHelpersValue, inline: false }
        ])
        .setFooter({ text: `Requested by ${raid.requesterTag || raid.requesterId} • ${new Date(raid.createdAt).toLocaleString()}` });
    
    if (raid.robloxAvatarUrl) {
        embed.setThumbnail(raid.robloxAvatarUrl);
    }
    
    return embed;
}

function getTopEntries(ranking, max = 5) {
    return Object.entries(ranking)
        .sort((a, b) => b[1] - a[1])
        .slice(0, max);
}

function getRaidProfileContext(userId) {
    const raids = loadRaids();
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

async function getLeaderboardUserProfile(client, userId) {
    const cached = profileCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL) {
        return cached;
    }

    let discordUser = null;
    try {
        discordUser = await client.users.fetch(userId).catch(() => null);
    } catch (error) {
        console.error('Failed to fetch Discord user for leaderboard:', error);
    }

    const context = getRaidProfileContext(userId);
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

async function buildLeaderboardEmbed(client, topEntries) {
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
        const profile = await getLeaderboardUserProfile(client, entry.userId);
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

    const rankOneProfile = sections.length > 0 ? await getLeaderboardUserProfile(client, topEntries[0].userId) : null;
    if (rankOneProfile?.avatarUrl) {
        embed.setThumbnail(rankOneProfile.avatarUrl);
    } else if (client?.user?.displayAvatarURL) {
        embed.setThumbnail(client.user.displayAvatarURL({ size: 256 }));
    }

    embed.setDescription(`Top 20 Most Active Raiders\n\n${sections.join('\n')}`);
    return embed;
}

async function buildLeaderboardEmbeds(client, topEntries = null) {
    const entries = topEntries || await leaderboardDb.getTopLeaderboard(20);
    return [await buildLeaderboardEmbed(client, entries)];
}

async function publishLeaderboard(client) {
    const settings = loadSettings();
    if (!settings.leaderboardChannel) return;

    const channel = await client.channels.fetch(settings.leaderboardChannel).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    
    const topEntries = await leaderboardDb.getTopLeaderboard(20);
    const embeds = await buildLeaderboardEmbeds(client, topEntries);
    
    if (settings.leaderboardMessageId) {
        const existing = await channel.messages.fetch(settings.leaderboardMessageId).catch(() => null);
        if (existing) {
            try {
                await existing.edit({ embeds });
                return;
            } catch (error) {
                if (error?.code === 10008) {
                    settings.leaderboardMessageId = null;
                    saveSettings(settings);
                } else {
                    throw error;
                }
            }
        } else {
            settings.leaderboardMessageId = null;
            saveSettings(settings);
        }
    }
    
    const message = await channel.send({ embeds });
    settings.leaderboardMessageId = message.id;
    saveSettings(settings);
}

async function syncLeaderboardMessage(client) {
    await publishLeaderboard(client);
}

module.exports = {
    ensureDataFiles,
    loadSettings,
    saveSettings,
    loadRaids,
    saveRaids,
    canCreateRaid,
    isBlacklisted,
    blacklistUser,
    createRaid,
    getRaidById,
    addHelper,
    removeHelper,
    closeRaid,
    updateRaidMessageReference,
    formatRaidMessage,
    publishLeaderboard,
    syncLeaderboardMessage,
    closeAllRaids,
    buildLeaderboardEmbeds
};