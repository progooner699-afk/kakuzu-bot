const fs = require('fs');
const path = require('path');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const leaderboardDb = require('./leaderboardDb');

const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
const raidsPath = path.join(__dirname, '..', 'data', 'raids.json');

const defaultSettings = {
    raidChannel: null,
    helpChannel: null,
    lbChannel: null,
    leaderboardLogChannel: null,
    leaderboardMessageId: null
};

const defaultRaids = {
    lastRaidId: 0,
    raids: [],
    activeRaidByOwner: {},
    blacklist: {},
    leaderboard: {
        daily: {},
        weekly: {},
        allTime: {},
        dailyReset: 0,
        weeklyReset: 0
    }
};

const REGION_ROLE_IDS = {
    ASIA: '1516663854354923620',
    EU: '1516664062438674462',
    NA: '1516664149793439775',
    SA: '1516664182194307082',
    AUST: '1522551121615523910'
};

const RAID_CLOSE_ROLE_NAMES = [
    'Administrator',
    'Management Supervisor',
    'Community Manager',
    'Senior Moderator',
    'Moderator',
    'Admin'
];

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

function normalizeRegion(input) {
    const value = normalizeText(input).toUpperCase();
    if (['ASIA', 'AS'].includes(value)) return 'ASIA';
    if (['EU', 'EUROPE'].includes(value)) return 'EU';
    if (['NA', 'NORTH AMERICA', 'USA', 'US'].includes(value)) return 'NA';
    if (['SA', 'SOUTH AMERICA'].includes(value)) return 'SA';
    if (['AUST', 'AUSTRALIA', 'AUS'].includes(value)) return 'AUST';
    return value || 'UNKNOWN';
}

function getRegionRoleId(region) {
    return REGION_ROLE_IDS[normalizeRegion(region)] || null;
}

function getRegionRoleMention(region) {
    const roleId = getRegionRoleId(region);
    return roleId ? `<@&${roleId}>` : null;
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

function canCloseRaid(member, raid) {
    if (!member || !raid) return false;
    if (member.id === raid.requesterId) return true;
    if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
    return member.roles?.cache?.some(role => RAID_CLOSE_ROLE_NAMES.includes(role.name)) || false;
}

function createRaid(options) {
    if (!canCreateRaid(options.requesterId)) {
        throw new Error('User already has an active raid or is blocked from creating new raids.');
    }
    const raids = loadRaids();
    resetLeaderboardsIfNeeded(raids);
    const nextId = raids.lastRaidId + 1;
    const teamersCount = getTeamersCount(options.teamers);
    const normalizedRegion = normalizeRegion(options.region);
    const raid = {
        raidId: nextId,
        status: 'OPEN',
        requesterId: options.requesterId,
        requesterTag: options.requesterTag,
        robloxUsername: normalizeText(options.robloxUsername),
        robloxAvatarUrl: options.robloxAvatarUrl || null,
        serverLink: normalizeText(options.serverLink),
        region: normalizedRegion,
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
        createdAt: Date.now(),
        resultOutcome: null,
        resultImageUrl: null,
        resultSummary: null,
        resultStatus: 'PENDING'
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

async function addHelper(raidId, userId) {
    const raids = loadRaids();
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid || raid.status === 'CLOSED') return { success: false, message: 'Raid is closed.' };
    if (raid.helpers.includes(userId)) return { success: false, message: 'You are already helping this raid.' };
    if (await leaderboardDb.hasAcceptedRaid(raidId, userId)) return { success: false, message: 'You have already accepted this raid alert.' };
    if (raid.helpers.length >= raid.helperLimit) return { success: false, message: 'Raid is already full.' };
    raid.helpers.push(userId);
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
    const index = raid.helpers.indexOf(userId);
    if (index === -1) return { success: false, message: 'You are not a helper on this raid.' };
    raid.helpers.splice(index, 1);
    updateRaidStatus(raid);
    saveRaids(raids);
    return { success: true, raid };
}

function closeRaid(raidId) {
    const raids = loadRaids();
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return null;
    raid.status = 'CLOSED';
    raid.resultStatus = 'CLOSED';
    if (raids.activeRaidByOwner[raid.requesterId] === raid.raidId) {
        delete raids.activeRaidByOwner[raid.requesterId];
    }
    saveRaids(raids);
    return raid;
}

function setRaidResult(raidId, options = {}) {
    const raids = loadRaids();
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return null;
    const outcome = normalizeText(options.outcome || '').toUpperCase();
    raid.resultOutcome = outcome || null;
    raid.resultImageUrl = normalizeText(options.imageUrl) || null;
    raid.resultSummary = normalizeText(options.note) || null;
    raid.resultStatus = outcome || 'PENDING';
    saveRaids(raids);
    return raid;
}

function closeAllRaids() {
    const raids = loadRaids();
    let closedCount = 0;

    for (const raid of raids.raids) {
        if (raid.status !== 'CLOSED') {
            raid.status = 'CLOSED';
            raid.resultStatus = 'CLOSED';
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
    const liveHelpersValue = helperCount > 0 ? raid.helpers.map((h) => `• <@${h}>`).join('\n') : '• None yet';

    const embed = new EmbedBuilder()
        .setTitle('🚨 Raid Alert')
        .setColor(0xFFD700)
        .setDescription('This help request is currently active.')
        .addFields([
            { name: 'Requested By', value: raid.requesterTag || `<@${raid.requesterId}>`, inline: true },
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

function formatRaidResultEmbed(raid) {
    const helperCount = (raid.helpers && raid.helpers.length) || 0;
    const statusValue = raid.status === 'CLOSED' ? 'CLOSED' : (raid.resultOutcome ? raid.resultOutcome.toUpperCase() : 'PENDING');
    const color = raid.status === 'CLOSED' ? 0x808080 : (raid.resultOutcome === 'WIN' ? 0x2ecc71 : raid.resultOutcome === 'LOSS' ? 0xe74c3c : raid.resultOutcome === 'DRAW' ? 0xf1c40f : 0x3498db);
    const embed = new EmbedBuilder()
        .setTitle('📊 Raid Result')
        .setColor(color)
        .setDescription(`Raid result update for request #${raid.raidId}.`)
        .addFields([
            { name: 'Requested By', value: raid.requesterTag || `<@${raid.requesterId}>`, inline: true },
            { name: 'Region', value: `\`${raid.region || 'Unknown'}\``, inline: true },
            { name: 'Status', value: `\`${statusValue}\``, inline: true },
            { name: 'Helpers', value: `\`${helperCount}/${raid.helperLimit || 0}\``, inline: true },
            { name: 'Teamers', value: raid.teamers ? `\`${raid.teamers}\`` : '`None`', inline: true },
            { name: 'Enemy Count', value: `\`${raid.enemyCount || 0}\``, inline: true }
        ])
        .setFooter({ text: `Raid ID ${raid.raidId} • ${new Date(raid.createdAt).toLocaleString()}` });

    if (raid.resultImageUrl) {
        embed.setImage(raid.resultImageUrl);
    }

    if (raid.resultSummary) {
        embed.addFields({ name: 'Result Notes', value: `\`${raid.resultSummary}\``, inline: false });
    }

    return embed;
}

function getTopEntries(ranking, max = 5) {
    return Object.entries(ranking)
        .sort((a, b) => b[1] - a[1])
        .slice(0, max);
}

function formatLeaderboardSection(title, ranking) {
    const entries = getTopEntries(ranking);
    if (!entries.length) {
        return `${title}\n• No helpers yet`;
    }
    return [title, ...entries.map(([userId, count], index) => `${index + 1}. <@${userId}> — ${count}`)].join('\n');
}

function updateLeaderboard(userId) {
    const raids = loadRaids();
    resetLeaderboardsIfNeeded(raids);
    raids.leaderboard.daily[userId] = (raids.leaderboard.daily[userId] || 0) + 1;
    raids.leaderboard.weekly[userId] = (raids.leaderboard.weekly[userId] || 0) + 1;
    raids.leaderboard.allTime[userId] = (raids.leaderboard.allTime[userId] || 0) + 1;
    saveRaids(raids);
}

function formatRankLabel(rank) {
    return rank < 10 ? `Rank ${rank}  |` : `Rank ${rank} |`;
}

function buildLeaderboardDescription(topEntries) {
    if (!topEntries.length) {
        return '• `No accepted raid data yet.`';
    }

    return topEntries.map((entry, index) => {
        const rank = index + 1;
        return `- \`${formatRankLabel(rank)}\` <@${entry.userId}> \`- ${entry.raidCount} Raids\``;
    }).join('\n');
}

function buildLeaderboardEmbed(topEntries) {
    const description = buildLeaderboardDescription(topEntries);
    return new EmbedBuilder()
        .setTitle('🏆 Raid Helper Leaderboard')
        .setDescription(description)
        .setColor(0x22b14c)
        .setFooter({ text: `Updated ${new Date().toLocaleString()}` })
        .setTimestamp();
}

function getLeaderboardEntries() {
    const raids = loadRaids();
    resetLeaderboardsIfNeeded(raids);
    return Object.entries(raids.leaderboard.allTime || {})
        .map(([userId, count]) => ({ userId, count }))
        .sort((a, b) => b.count - a.count || a.userId.localeCompare(b.userId));
}

async function publishLeaderboard(client) {
    const settings = loadSettings();
    if (!settings.lbChannel) return;
    const channel = await client.channels.fetch(settings.lbChannel).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const topEntries = await leaderboardDb.getTopLeaderboard(15);
    const embed = buildLeaderboardEmbed(topEntries);
    if (settings.leaderboardMessageId) {
        const existing = await channel.messages.fetch(settings.leaderboardMessageId).catch(() => null);
        if (existing) {
            try {
                await existing.edit({ content: null, embeds: [embed] });
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
    const message = await channel.send({ embeds: [embed] });
    settings.leaderboardMessageId = message.id;
    saveSettings(settings);
}

async function syncLeaderboardMessage(client) {
    const settings = loadSettings();
    if (!settings.lbChannel) return;
    const channel = await client.channels.fetch(settings.lbChannel).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const topEntries = await leaderboardDb.getTopLeaderboard(15);
    const embed = buildLeaderboardEmbed(topEntries);
    if (settings.leaderboardMessageId) {
        const existing = await channel.messages.fetch(settings.leaderboardMessageId).catch(() => null);
        if (existing) {
            try {
                await existing.edit({ content: null, embeds: [embed] });
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
    const message = await channel.send({ embeds: [embed] });
    settings.leaderboardMessageId = message.id;
    saveSettings(settings);
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
    canCloseRaid,
    createRaid,
    getRaidById,
    addHelper,
    removeHelper,
    closeRaid,
    setRaidResult,
    updateRaidMessageReference,
    formatRaidMessage,
    formatRaidResultEmbed,
    publishLeaderboard,
    syncLeaderboardMessage,
    getLeaderboardEntries,
    closeAllRaids,
    normalizeRegion,
    getRegionRoleId,
    getRegionRoleMention
};
