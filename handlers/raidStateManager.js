const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ChannelType } = require('discord.js');
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
    // Channel where the official /link-roblox verification embed lives. Used to
    // dynamically point unverified users to the correct channel in guard messages.
    verificationChannel: null
};

const defaultRaids = {
    lastRaidId: 0,
    // Per-Roblox-server raid counter: serverId -> number of raids created on
    // that Roblox game-server. The DISPLAYED raid number (raid alert / Raid ID /
    // raid count) counts per server (each server starts at #1) while the internal
    // unique raidId stays guild-wide for lookups, keys and channel names.

    serverRaidCount: {},
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

// ISO-3166 alpha-2 -> human-readable country name used to render the "Country"
// field on raid alert embeds (V2 payload AND the plain embed fallback).
// Lookup stays on the standardized uppercase alpha-2 code internally.
const COUNTRY_NAMES = {
    US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina',
    CL: 'Chile', CO: 'Colombia', PE: 'Peru', VE: 'Venezuela', UY: 'Uruguay',
    GB: 'United Kingdom', DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain',
    PT: 'Portugal', NL: 'Netherlands', BE: 'Belgium', CH: 'Switzerland', AT: 'Austria',
    SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland',
    CZ: 'Czechia', HU: 'Hungary', RO: 'Romania', GR: 'Greece', IE: 'Ireland',
    RU: 'Russia', UA: 'Ukraine', TR: 'Turkey', IN: 'India', CN: 'China',
    JP: 'Japan', KR: 'South Korea', SG: 'Singapore', MY: 'Malaysia', ID: 'Indonesia',
    TH: 'Thailand', VN: 'Vietnam', PH: 'Philippines', PK: 'Pakistan', BD: 'Bangladesh',
    AE: 'United Arab Emirates', SA: 'Saudi Arabia', IL: 'Israel', QA: 'Qatar', KW: 'Kuwait',
    AU: 'Australia', NZ: 'New Zealand', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya',
    EG: 'Egypt', MA: 'Morocco', GH: 'Ghana'
};

/**
 * Converts an ISO-3166 alpha-2 country code (e.g. 'IN') into a human-readable
 * country name (e.g. 'India'). Returns 'Unknown' when the code is missing or not
 * in the lookup table.
 */
function countryCodeToName(countryCode) {
    const cc = String(countryCode || '').trim().toUpperCase();
    if (!cc) return 'Unknown';
    return COUNTRY_NAMES[cc] || cc;
}

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
// Per-server raid index: the DISPLAYED raid number (alert title / Raid ID / count.

    // Each Roblox game-server keeps its own sequence starting at one, so raids in
    // different Roblox servers don't share one guild-wide counter. When no serverId
    // is known (no live presence detection) fall back to a shared guild counter.
    const serverKey = normalizeText(options.serverId) || '__guild__';
    const serverIndex = (raids.serverRaidCount[serverKey] || 0) + 1;
    const teamersCount = getTeamersCount(options.teamers);
        const raid = {
        raidId: nextId,
        serverIndex,
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
        countryCode: normalizeText(options.countryCode),
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
    raids.serverRaidCount[serverKey]= serverIndex;
    raids.raids.push(raid);
    if (!isDraft && raid.requesterId) {
        raids.activeRaidByOwner[raid.requesterId] = raid.raidId;
    }
    saveRaids(options.guildId, raids);
    return raid;
}

/**
 * Returns the raid number that should be DISPLAYED to users.
 * Raids are numbered per Roblox game-server: raid.serverIndex holds the
 * per-server sequence (one, two, three, ...), so a raid in server A shows
 * number one, a raid in server B also number one, instead of the next guild-wide
 * number. Legacy raids saved before per-server counting fall back to the still
 * unique internal raidId, so old data keeps displaying the same numbers.

 */
function getRaidDisplayId(raid) {
    if (!raid) return 0;
    return raid.serverIndex ? raid.serverIndex : raid.raidId;

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
        robloxAvatarUrl: robloxData.avatarUrl || null,
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

/**
 * Derive the alert status from the LIVE helper count:
 *   CLOSED only when the raid is actually closed, FULL when the helper count
 *   reached the limit, otherwise OPEN. The raw stored status is never trusted
 *   for OPEN/FULL rendering — a freshly posted raid is still a 'PENDING'
 *   draft when the alert is first built, and the old code rendered that as
 *   CLOSED (the "status shows CLOSED only" bug).
 */
function resolveRaidStatus(raid, helperCount) {
    if (raid && raid.status === 'CLOSED') return 'CLOSED';
    const limit = Number(raid && raid.helperLimit) || 0;
    const count = (helperCount !== undefined && helperCount !== null)
        ? helperCount
        : ((raid && raid.helpers && raid.helpers.length) || 0);
    if (limit > 0 && count >= limit) return 'FULL';
    return 'OPEN';
}

function formatRaidMessage(raid, guildId = null) {
    const helperCount = (raid.helpers && raid.helpers.length) || 0;
    const statusText = resolveRaidStatus(raid, helperCount);
    const gameLabel = GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';
    const createdMs = Number(raid.createdAt) || Date.now();
    const createdTs = Math.floor(createdMs / 1000);
    const reasonText = raid.reason ? raid.reason : 'No details provided';
    const countryName = countryCodeToName(raid.countryCode);

    const statusEmoji = statusText === 'OPEN' ? '\u{1F7E2}' : statusText === 'FULL' ? '\u{1F7E0}' : '\u{1F534}';

    const helperNamesList = helperCount > 0
        ? raid.helpers.map((h) => {
            if (typeof h === 'string') return '<@' + h + '>';
            return h.robloxDisplayName || h.robloxUsername || '<@' + h.userId + '>';
        }).join(', ')
        : 'None';

    const targetDisplay = raid.robloxUsername || '<@' + raid.requesterId + '>';

    const EMBED_DIVIDER = '\u2500'.repeat(42);

    const embeds = [];

    const embed = new EmbedBuilder()
        .setTitle('RAID ALERT')
        .setDescription((raid.pingMention ? raid.pingMention + '\n' : '') + '\u{1F6A8} **RAID ALERT**\n\n> \u{1F64F} Please remain patient while our helpers make their way to assist you. Someone will be with you shortly!')
        .addFields([
            {
            name: '🎯 ENEMY NAMES',
            value: '```' + '\n' + 'Enemy Clan: ' + (raid.enemyClanNames || 'Unknown') + '\n' + 'Enemies: ' + (raid.enemyNames || 'None') + '\n' + '```',
            inline: false
            },
            {
                name: '\u{1F4CB} DETAILS :',
                value: '> **Game:** ' + gameLabel + '\n' +
                    '> **Raid ID:** `' + getRaidDisplayId(raid) + '`\n' +
                    '> **Region:** `' + (raid.region || 'Unknown') + '`\n' +
                    '> **Country:** `' + countryName + '`\n' +
                    '> **Status:** `' + statusEmoji + ' ' + statusText + '`\n' +
                    '> **Time Requested:** <t:' + createdTs + ':f>',
                inline: false
            },
            { name: '\u200b', value: EMBED_DIVIDER, inline: false },
            {
                name: '\u{1F4CB} IN-GAME HELPERS :',
                value: '> **Helpers:** `' + helperNamesList + '`\n' +
                    '> **Total Helpers:** `' + helperCount + ' / ' + (raid.helperLimit || 0) + '`',
                inline: false
            },
            { name: '\u200b', value: EMBED_DIVIDER, inline: false },
            {
                name: '\u{1F4DD} DESCRIPTION',
                value: '```' + '\n' + reasonText + '\n' + '```',
                inline: false
            },
        ])
        .setFooter({ text: 'Raid #' + getRaidDisplayId(raid) + ' \u2022 ' + new Date(createdMs).toLocaleDateString() })
        .setTimestamp();

    if (raid.robloxAvatarUrl) {
        embed.setThumbnail(raid.robloxAvatarUrl);
    }

    embeds.push(embed);

    if (helperCount > 0) {
        const liveHelpersList = raid.helpers.map((h) => {
            if (typeof h === 'string') return '• <@' + h + '>';
            const helperName = h.robloxDisplayName || h.robloxUsername || '<@' + h.userId + '>';
            const timeSpent = (h && h.timeSpentSeconds) ? ' \u23F1 ' + formatTimeSpent(h.timeSpentSeconds) : '';
            return '• <@' + h.userId + '> \u2014 **' + helperName + '**' + timeSpent;
        }).join('\n');

        const helpersDesc = '## LIVE HELPERS\n\n' +
            '`' + helperCount + ' / ' + (raid.helperLimit || 0) + '`\n\n' +
            liveHelpersList;

        const helpersEmbed = new EmbedBuilder()
            .setDescription(helpersDesc)
            .setFooter({ text: 'Raid #' + getRaidDisplayId(raid) + ' \u2022 ' + new Date(createdMs).toLocaleDateString() })
            .setTimestamp();

        embeds.push(helpersEmbed);
    }

    return embeds;
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
            // Roblox presence API returns INTEGERS: 0 Offline, 1 Online,
            // 2 InGame, 3 InStudio, 4 Invisible. (The old string 'InGame'
            // comparison never matched, so time tracking never fired.)
            if (user.userPresenceType === 2 && !helper.lastSeenTime) {
                helper.lastSeenTime = Date.now();
            } else if (user.userPresenceType !== 2 && helper.lastSeenTime) {
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

// Persist the ping mention (e.g. '<@&ROLE_ID>') that is rendered INSIDE the
// raid alert (first line of the description / V2 header) so later alert edits
// (accept / leave / close / auto-join) re-render it instead of dropping it.
function setRaidPingMention(raidId, mention, guildId) {
    const raids = loadRaids(guildId);
    const raid = raids.raids.find(item => item.raidId === raidId);
    if (!raid) return null;
    raid.pingMention = mention || null;
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

// ---- Raid alert webhook + temporary alert channel ---------------------------
// Raid alerts are NOT posted as the bot account and NOT in a fixed channel:
// every raid gets its own temporary text channel (raid-alert-<raidId>) created
// in the SAME CATEGORY as the configured raid result channel, and the alert is
// posted through a webhook named 'backupalerts' (dummy profile).
const RAID_ALERT_WEBHOOK_NAME = 'backupalerts';
// How long after a raid closes its temporary alert channel is deleted.
const RAID_TEMP_CHANNEL_DELETE_DELAY_MS = 60 * 1000;
// Dedupe guard so a raid's temp channel is only scheduled for deletion once.
const pendingAlertChannelDeletions = new Map();

/**
 * Creates the temporary raid alert channel (raid-alert-<raidId>) in the given
 * category (the result channel's category) and persists its id on the raid
 * record as alertChannelId. Returns the channel or null. Never throws.
 */
async function createRaidAlertChannel(client, raid, guildId, categoryId) {
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return null;
        const channel = await guild.channels.create({
            name: 'raid-alert-' + raid.raidId,
            type: ChannelType.GuildText,
            parent: categoryId || undefined,
            topic: 'Temporary raid alert channel for raid #' + raid.raidId + '. Auto-deletes 1 minute after the raid closes.',
            reason: 'Temporary raid alert channel for raid #' + raid.raidId
        }).catch((err) => {
            console.warn('[raid alert] temp channel create failed:', (err && err.message) || err);
            return null;
        });
        if (channel) {
            raid.alertChannelId = channel.id;
            const raids = loadRaids(guildId);
            const stored = raids.raids.find(item => item.raidId === raid.raidId);
            if (stored) {
                stored.alertChannelId = channel.id;
                saveRaids(guildId, raids);
            }
        }
        return channel || null;
    } catch (err) {
        console.warn('[raid alert] temp channel create failed:', (err && err.message) || err);
        return null;
    }
}

/**
 * Finds (or creates) the 'backupalerts' webhook in the given channel.
 * Returns the webhook or null. Never throws.
 */
async function getRaidAlertWebhook(channel) {
    try {
        if (!channel || !channel.isTextBased()) return null;
        const webhooks = await channel.fetchWebhooks().catch(() => null);
        let webhook = webhooks ? webhooks.find(w => w.name === RAID_ALERT_WEBHOOK_NAME) : null;
        if (!webhook) {
            webhook = await channel.createWebhook({
                name: RAID_ALERT_WEBHOOK_NAME,
                reason: 'Raid alert webhook (backupalerts dummy profile)'
            }).catch((err) => {
                console.warn('[raid alert] webhook create failed:', (err && err.message) || err);
                return null;
            });
        }
        return webhook || null;
    } catch (err) {
        console.warn('[raid alert] webhook lookup failed:', (err && err.message) || err);
        return null;
    }
}

/**
 * Edits an existing raid alert message. Alerts are authored by the
 * 'backupalerts' webhook, so edits MUST go through webhook.editMessage —
 * message.edit on a webhook-authored message is rejected by Discord.
 * Falls back to message.edit for legacy (bot-authored) alerts. Never throws.
 */
async function editRaidAlertMessage(client, raid, payload) {
    try {
        if (!raid || !raid.channelId || !raid.messageId) return null;
        const channel = await client.channels.fetch(raid.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return null;
        const webhook = await getRaidAlertWebhook(channel);
        if (webhook) {
            return await webhook.editMessage(raid.messageId, payload).catch((err) => {
                console.warn('[raid alert] webhook edit failed:', (err && err.message) || err);
                return null;
            });
        }
        // Legacy fallback: alert posted by the bot account itself.
        const message = await channel.messages.fetch(raid.messageId).catch(() => null);
        if (!message) return null;
        return await message.edit(payload).catch((err) => {
            console.warn('[raid alert] message edit failed:', (err && err.message) || err);
            return null;
        });
    } catch (err) {
        console.warn('[raid alert] edit failed:', (err && err.message) || err);
        return null;
    }
}

/**
 * Schedules deletion of a raid's temporary alert channel (alertChannelId).
 * Called when the raid closes; the channel is deleted after delayMs
 * (default: 1 minute). Safe to call multiple times — deduped per raid.
 */
function scheduleRaidAlertChannelDeletion(client, raidId, guildId, delayMs) {
    try {
        const wait = (typeof delayMs === 'number') ? delayMs : RAID_TEMP_CHANNEL_DELETE_DELAY_MS;
        const key = guildId + ':' + raidId;
        if (pendingAlertChannelDeletions.has(key)) return;
        const raid = getRaidById(raidId, guildId);
        const channelId = raid && raid.alertChannelId;
        if (!channelId) return;
        const timer = setTimeout(async () => {
            pendingAlertChannelDeletions.delete(key);
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                await channel.delete('Raid closed — temporary raid alert channel cleanup').catch((err) => {
                    console.warn('[raid alert] temp channel delete failed:', (err && err.message) || err);
                });
            }
        }, wait);
        pendingAlertChannelDeletions.set(key, timer);
    } catch (err) {
        console.warn('[raid alert] deletion schedule failed:', (err && err.message) || err);
    }
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
    setRaidPingMention,
    RAID_ALERT_WEBHOOK_NAME,
    resolveRaidStatus,
    createRaidAlertChannel,
    getRaidAlertWebhook,
    editRaidAlertMessage,
    scheduleRaidAlertChannelDeletion,
    cleanupPendingRaids,
    getRaidById,
    getRaidDisplayId,
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
    countryCodeToName,
    setRaidMvp,
    pollHelperPresences
};