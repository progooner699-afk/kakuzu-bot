'use strict';

const {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ThumbnailBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    EmbedBuilder
} = require('discord.js');

const rsm = require('./raidStateManager');

const RAID_RESULT_V2_FLAGS = 1 << 15;
const RESULT_NEUTRAL_COLOR = 0x2B2D31;
const DEFAULT_BANNER_IMAGE = 'https://files.catbox.moe/iyqyrd.gif';
const DEFAULT_MVP_PFP_URL = 'https://files.catbox.moe/iyqyrd.gif';

const NL = String.fromCharCode(10);

const RESULT_STYLES = {
    win:     { word: 'WON',     accent: 0x248046, titleEmoji: '\uD83C\uDFC6', message: 'Congratulations to every helper who showed up, GG on the win!' },
    whooped: { word: 'WHOOPED', accent: 0xf1c40f, titleEmoji: '\uD83D\uDC80', message: 'We whooped them! Absolute domination, GG to every helper!' },
    loss:    { word: 'LOST',    accent: 0xda373c, titleEmoji: '\u274C', message: 'Tough loss, but great effort from everyone - we go again!' }
};

const OUTCOME_STYLES = {
    win: { title: 'RAID WON ' + '<:won:1543997297593946162>' },
    whooped: { title: 'RAID WHOOPED \uD83D\uDC80' },
    loss: { title: 'RAID LOST \u274C' }
};

function getOutcomeStyle(outcome) {
    const s = RESULT_STYLES[outcome];
    if (!s) return { word: 'UNKNOWN', accent: 0x4e5058, message: null, title: 'RAID RESULT', titleEmoji: '' };
    const os = OUTCOME_STYLES[outcome] || { title: 'RAID ' + s.word };
    return { word: s.word, accent: s.accent, message: s.message, title: os.title, titleEmoji: s.titleEmoji };
}

function findHelper(helpers, mvpUserId) {
    if (!Array.isArray(helpers) || !mvpUserId) return null;
    return helpers.find(h => typeof h === 'object' && h && h.userId === mvpUserId) || null;
}

function formatDayTime(ms) {
    const d = new Date(ms);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' at ' + hh + ':' + mm;
}

function sanitize(str, maxLen) {
    if (str == null) return '';
    let s = String(str);
    s = s.replace(/[<>@]/g, '');
    s = s.replace(/[`*_~|>#[\]()]/g, '');
    s = s.replace(/\n/g, ' ');
    if (maxLen) s = s.slice(0, maxLen);
    return s;
}

function buildProofLinks(urls, maxLinks) {
    maxLinks = maxLinks || 8;
    const list = (Array.isArray(urls) ? urls : []).filter(u => typeof u === 'string' && u).slice(0, maxLinks);
    if (list.length === 0) return 'No raid pictures uploaded.';
    const parts = list.map((url, i) => '[Image ' + (i+1) + '](' + url + ')');
    let value = '';
    for (const part of parts) {
        const cand = value ? value + ' \u2022 ' + part : part;
        if (cand.length > 1024) break;
        value = cand;
    }
    return value || parts[0];
}
function buildResultCardPayload(opts) {
    const raid = opts.raid || {};
    const outcome = opts.outcome || 'win';
    const submitterId = opts.submitterId || raid.closedBy || null;
    const rallyPicUrl = opts.rallyPicUrl || null;
    const proofUrls = Array.isArray(opts.proofUrls) ? opts.proofUrls : [];
    const endedAtMs = opts.endedAtMs || raid.closedAt || Date.now();
    const startedAtMs = Number(raid.createdAt) || endedAtMs;

    const style = getOutcomeStyle(outcome);

    const text = function (content) { return new TextDisplayBuilder().setContent(content).toJSON(); };
    const separator = function () { return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small).toJSON(); };

    const container = new ContainerBuilder().setAccentColor(style.accent).toJSON();
    container.size = 'large';
    const contents = [];

    const bannerUrl = rallyPicUrl || DEFAULT_BANNER_IMAGE;
    if (bannerUrl) {
        contents.push(new MediaGalleryBuilder().addItems([
            new MediaGalleryItemBuilder().setURL(bannerUrl).setDescription(style.title).toJSON()
        ]).toJSON());
        contents.push(separator());
    }

    contents.push(text('## ' + style.title + ' \u2014 #' + raid.raidId + ' \u2502 ' + (raid.requesterId ? '<@' + raid.requesterId + '>' : '')));
    contents.push(separator());

    const durationSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
    const noteText = opts.endersNote || raid.endersNote || raid.closeReason || null;
    let infoLines = '### \u2139\uFE0F INFO' + NL +
        '> **Requested by** ' + (raid.requesterId ? '<@' + raid.requesterId + '>' : 'Unknown') +
        ' \u2502 **Ended by** ' + (submitterId ? '<@' + submitterId + '>' : 'Unknown') +
        ' \u2502 **Duration** `' + rsm.formatTimeSpent(durationSeconds) + '`';
    if (noteText) {
        const note = String(noteText).replace(/\n/g, ' ').slice(0, 300);
        infoLines += NL + '> \uD83D\uDCDD **Ender\'s note** *' + note + '*';
    }
    contents.push(text(infoLines));
    contents.push(separator());

    const mvpHelper = findHelper(raid.helpers, raid.mvpUserId);
    if (mvpHelper) {
        const mvpName = mvpHelper.robloxDisplayName || mvpHelper.robloxUsername || 'Unknown';
        const mvpRobloxId = mvpHelper.robloxUserId || null;
        const mvpProfileUrl = mvpRobloxId ? 'https://www.roblox.com/users/' + mvpRobloxId + '/profile' : null;
        const mvpPfpUrl = mvpHelper.avatarUrl || DEFAULT_MVP_PFP_URL;
        const mvpText = '### \uD83D\uDC51 RAID MVP' + NL +
            '> **' + mvpName + '** \u2502 **Roblox** ' + (mvpProfileUrl ? '[' + (mvpHelper.robloxUsername || mvpName) + '](' + mvpProfileUrl + ')' : (mvpHelper.robloxUsername || mvpName)) + NL +
            '> **Discord** ' + (mvpHelper.userId ? '<@' + mvpHelper.userId + '>' : 'Unknown') +
            ' \u2502 **Time spent** `' + rsm.formatTimeSpent(mvpHelper.timeSpentSeconds || 0) + '`';
        contents.push(new SectionBuilder()
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(mvpPfpUrl).setDescription('MVP profile picture'))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(mvpText))
            .toJSON());
        contents.push(separator());
    }

    const streakLine = opts.streakLine || opts.streakMessage || null;
    if (streakLine) {
        contents.push(text('\uD83D\uDD25 **STREAK HOLDER** ' + streakLine));
        contents.push(separator());
    }
    const gameLabel = rsm.GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';
    const enemyClans = raid.enemyClanNames || 'none';
    const enemies = raid.enemyNames || 'none';
    const enemyCount = raid.enemyCount || 0;
    const allyClans = raid.allyClanNames || 'none';
    const allies = raid.allyNames || 'none';
    const allyCount = allies === 'none' ? 0 : String(allies).split(',').length;
    const battleText = '### \u2694\uFE0F BATTLE' + NL + '```' + NL +
        'Enemy Clan : ' + enemyClans + NL +
        'Enemies    : ' + enemies + ' (' + enemyCount + ')' + NL +
        'Ally Clan  : ' + allyClans + NL +
        'Allies     : ' + allies + ' (' + allyCount + ')' + NL +
        '```';
    contents.push(text(battleText));
    contents.push(separator());

    const proofUrls2 = Array.isArray(opts.proofUrls) ? opts.proofUrls : [];
    const proofText = proofUrls2.length > 0 ? proofUrls2.length + ' picture(s) below' : 'No raid pictures uploaded.';
    let detailsText = '### \uD83D\uDCCB RAID DETAILS' + NL +
        '> **Game** ' + gameLabel + ' \u2502 **Location** `' + (raid.region || 'Unknown') + '`' + NL +
        '> **Started** <t:' + Math.floor(startedAtMs / 1000) + ':f> \u2502 **Ended** <t:' + Math.floor(endedAtMs / 1000) + ':f>' + NL +
        '> **Proof** ' + proofText;
    contents.push(text(detailsText));
    if (proofUrls2.length > 0) {
        contents.push(new MediaGalleryBuilder().addItems(proofUrls2.slice(0,10).map(u => new MediaGalleryItemBuilder().setURL(u).toJSON())).toJSON());
    }
    contents.push(separator());

    const helpers = Array.isArray(raid.helpers) ? raid.helpers.filter(h => typeof h === 'object' && h && h.userId) : [];
    helpers.sort((a, b) => (b.timeSpentSeconds || 0) - (a.timeSpentSeconds || 0));
    let helpersText = '### \uD83D\uDEE1\uFE0F HELPERS (' + helpers.length + ')';
    if (helpers.length === 0) {
        helpersText += NL + 'No helpers recorded';
    } else {
        const shown = helpers.slice(0, 10);
        shown.forEach(function (h, i) {
            const name = h.robloxDisplayName || h.robloxUsername || 'Unknown';
            const crown = h.userId === raid.mvpUserId ? '\uD83D\uDC51 ' : '';
            helpersText += NL + (i + 1) + '. ' + crown + '**' + name + '** \u2502 <@' + h.userId + '> \u2502 `' + rsm.formatTimeSpent(h.timeSpentSeconds || 0) + '`';
        });
        if (helpers.length > 10) helpersText += NL + '-# +' + (helpers.length - 10) + ' more';
    }
    contents.push(text(helpersText));
    contents.push(separator());

    contents.push(text('-# Kakuzu Raid Network \u00B7 Raid #' + raid.raidId + (submitterId ? ' \u00B7 Result submitted by <@' + submitterId + '>' : '')));

    container.components = contents;
    return { flags: RAID_RESULT_V2_FLAGS, components: [container] };
}

function buildResultFallbackEmbed(opts) {
    const raid = opts.raid || {};
    const outcome = opts.outcome || 'win';
    const submitterId = opts.submitterId || raid.closedBy || null;
    const proofUrls = Array.isArray(opts.proofUrls) ? opts.proofUrls : [];
    const streakMessage = opts.streakMessage || null;
    const endedAtMs = opts.endedAtMs || raid.closedAt || Date.now();
    const startedAtMs = Number(raid.createdAt) || endedAtMs;
    const gameLabel = rsm.GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';
    const embed = new EmbedBuilder().setTitle(getOutcomeStyle(outcome).title).setColor(getOutcomeStyle(outcome).accent).setTimestamp();
    if (streakMessage) embed.setDescription(streakMessage);
    return embed;
}

function buildNoResultEmbed(opts) {
    const raid = opts.raid || {};
    const closedById = opts.closedById || raid.closedBy || null;
    const embed = new EmbedBuilder()
        .setTitle('\uD83D\uDED1 NO RAID RESULTS RECORDED')
        .setColor(0x888888)
        .setDescription('> \uD83D\uDCDD **Note:** Raid `#' + raid.raidId + '` was closed without a result card.' + NL + '> No outcome, streaks or raid metrics were recorded for this deployment.')
        .setTimestamp();
    return embed;
}

module.exports = {
    RAID_RESULT_V2_FLAGS: RAID_RESULT_V2_FLAGS,
    OUTCOME_STYLES: OUTCOME_STYLES,
    DEFAULT_BANNER_IMAGE: DEFAULT_BANNER_IMAGE,
    buildResultCardPayload: buildResultCardPayload,
    buildResultFallbackEmbed: buildResultFallbackEmbed,
    buildProofLinks: buildProofLinks,
    buildNoResultEmbed: buildNoResultEmbed
};