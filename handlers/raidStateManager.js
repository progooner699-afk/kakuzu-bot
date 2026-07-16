const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const robloxApi = require('./robloxApi');

const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
const raidsPath = path.join(__dirname, '..', 'data', 'raids.json');

const defaultSettings = {
    raidChannel: null,
    resultChannel: null,
    infoChannel: null
};

const defaultRaids = {
    lastRaidId: 0,
    raids: [],
    activeRaidByOwner: {},
    blacklist: {},
    streakType: 'NONE',
    streakCount: 0
};

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
    
    raids.activeRaidByOwner = Object.assign({}, defaultRaids.activeRaidByOwner, raids.activeRaidByOwner || {});
    
    const loadedRaids = Object.assign({}, defaultRaids, raids);
    rebuildActiveRaidByOwner(loadedRaids);
    return loadedRaids;
}

function saveRaids(raids) {
    fs.writeFileSync(raidsPath, JSON.stringify(raids, null, 4));
}

function rebuildActiveRaidByOwner(raids) {
    if (!raids.activeRaidByOwner) raids.activeRaidByOwner = {};
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
    
    // Prevent raid requester from accepting their own raid
    if (raid.requesterId === userId) {
        return { success: false, message: 'You cannot accept your own raid request.' };
    }
    
    const isAlreadyHelping = raid.helpers.some(h => typeof h === 'string' ? h === userId : h.userId === userId);
    if (isAlreadyHelping) return { success: false, message: 'You are already helping this raid.' };
    if (raid.helpers.length >= raid.helperLimit) return { success: false, message: 'Raid is already full.' };
    
    raid.helpers.push({
        userId: userId,
        robloxUsername: robloxData.username,
        robloxDisplayName: robloxData.displayName,
        robloxUserId: robloxData.userId
    });
    
    updateRaidStatus(raid);
    saveRaids(raids);
    return { success: true, raid };
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
    closeAllRaids
};