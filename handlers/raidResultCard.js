'use strict';

// Native Components V2 raid RESULT card — the interactive close-flow card
// built by this handler (the standalone /rwinner test command was removed).
// Same layout language as the retired static card:
//   - banner MediaGallery rendered FIRST (rally pic or default banner) so the
//     image sits at the TOP of the card, edge-to-edge full width
//   - neutral #2b2d31 Container accent -> no visible colored accent bar
//   - "INFO" text block (requested by / ended by / duration + Ender's Note)
//   - MVP block as a Section carrying the MVP profile-picture Thumbnail on the
//     RIGHT side (the only right-side media a V2 card supports)
//   - enemy / game / location / started / ended / proof text block
//   - "HELPERS" section with a native Separator divider between EVERY helper
//   - "Kakuzu Raid Network · Raid #<id> · Result submitted by @<user>" footer
// Three outcome styles are supported (win / whooped / loss); each renders the
// same card with a different title emoji.

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

// Message flag required for native Components V2 (IS_COMPONENTS_V2). V2
// messages disable `content` + `embeds`, so pings must be sent as a separate
// message before the card.
const RAID_RESULT_V2_FLAGS = 1 << 15;

// Accent color matched to Discord's dark chat background (#2b2d31) so the
// Container's left accent bar is effectively invisible.
const RESULT_NEUTRAL_COLOR = 0x2B2D31;

// Default top banner (hosted on catbox.moe — permanent, hotlinkable URL).
// Replaced by the uploaded RALLY PICTURE whenever the raid closer marks one
// with `rally` in the temporary upload channel.
const DEFAULT_BANNER_IMAGE = 'https://files.catbox.moe/iyqyrd.gif';

// Fallback MVP profile picture when the helper has no stored avatar URL.
const DEFAULT_MVP_PFP_URL = 'https://files.catbox.moe/iyqyrd.gif';

// Big-dot unicode bullet placed before every labeled INFO line (U+25CF).
const DOT = '\u25CF';

// Custom Discord emojis (hosted on the Discord CDN). The <:name:id> markdown
// resolves by the numeric ID, so it renders INLINE at emoji size in V2 text.
const INFO_EMOJI = '<:info:1543995035396218950>';
const MVP_EMOJI = '<:mvp:1543994867552882699>';
// "Won" emoji — the sunglasses-face rendered right after RAID WON.
const WON_EMOJI = '<:won:1543997297593946162>';

// The 3 result-card types. Win keeps the same look as the original /rwinner
// card; Whooped and Loss use their own emojis. Swap the emoji strings here to
// restyle (custom Discord emojis work as soon as you paste their <:name:id>
// markdown).
const OUTCOME_STYLES = {
    win: { title: 'RAID WON ' + WON_EMOJI },
    whooped: { title: 'RAID WHOOPED \uD83D\uDC80' },   // 💀 skull
    loss: { title: 'RAID LOST \u274C' }                 // ❌ cross mark
};

// Runtime newline used while composing TextDisplay content (avoids escape
// sequence mangling in the source file itself).
const NL = String.fromCharCode(10);

function getOutcomeStyle(outcome) {
    return OUTCOME_STYLES[outcome] || OUTCOME_STYLES.win;
}

function findHelper(helpers, mvpUserId) {
    if (!Array.isArray(helpers) || !mvpUserId) return null;
    return helpers.find(h => typeof h === 'object' && h && h.userId === mvpUserId) || null;
}

function formatDayTime(ms) {
    const d = new Date(ms);
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' at ' + hh + ':' + mm;
}

/**
 * Builds the native Components V2 result card payload.
 * @param {object} opts
 * @param {object} opts.raid            Closed raid record (raidStateManager).
 * @param {string} opts.outcome         'win' | 'whooped' | 'loss'
 * @param {string} opts.submitterId     Discord id of the user closing/submitting.
 * @param {string|null} [opts.rallyPicUrl]  Rally picture — becomes the TOP banner.
 * @param {string[]} [opts.proofUrls]   Raid proof image URLs (text links).
 * @param {number} [opts.endedAtMs]     Raid end epoch ms (defaults to now).
 * @returns {{ flags: number, components: object[] }}
 */
function buildResultCardPayload(opts) {
    const raid = opts.raid || {};
    const outcome = opts.outcome || 'win';
    const submitterId = opts.submitterId || raid.closedBy || null;
    const rallyPicUrl = opts.rallyPicUrl || null;
    const proofUrls = Array.isArray(opts.proofUrls) ? opts.proofUrls : [];
    const endedAtMs = opts.endedAtMs || raid.closedAt || Date.now();
    const startedAtMs = Number(raid.createdAt) || endedAtMs;

    const style = getOutcomeStyle(outcome);

    const text = function (content) {
        return new TextDisplayBuilder().setContent(content).toJSON(); // type 10
    };
    const separator = function () {
        return new SeparatorBuilder() // type 14
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small)
            .toJSON();
    };

    const container = new ContainerBuilder().setAccentColor(RESULT_NEUTRAL_COLOR).toJSON();
    container.size = 'large';
    const contents = [];

    // --- TOP banner: the rally picture (or the default banner) rendered
    // edge-to-edge across the full card width, ABOVE everything else ---
    contents.push(new MediaGalleryBuilder().addItems([
        new MediaGalleryItemBuilder()
            .setURL(rallyPicUrl || DEFAULT_BANNER_IMAGE)
            .setDescription(style.title)
            .toJSON()
    ]).toJSON());
    contents.push(separator());

    // --- ONE consolidated Info block ---
    const durationSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
    const noteText = raid.closeReason || raid.reason || null;

    contents.push(text(
        '## \uD83C\uDFC6 ' + style.title + ' — #' + raid.raidId + NL +
        NL +
        '### ' + INFO_EMOJI + ' INFO' + NL +
        DOT + ' **Requested By:** ' + (raid.requesterId ? '<@' + raid.requesterId + '>' : '**Unknown**') + NL +
        DOT + ' **Ended By:** ' + (submitterId ? '<@' + submitterId + '>' : '**Unknown**') + NL +
        DOT + ' **Raid Duration:** `' + rsm.formatTimeSpent(durationSeconds) + '`' + NL +
        (noteText
            ? NL + '> \uD83D\uDCDD **Ender\u2019s Note**' + NL + '> ' + String(noteText).replace(/\n/g, ' ')
            : '')
    ));

    // --- MVP section: profile picture as a Thumbnail accessory pinned to the
    // RIGHT side of the section. Only rendered when an MVP exists. ---
    const mvpHelper = findHelper(raid.helpers, raid.mvpUserId);
    if (mvpHelper) {
        const mvpName = mvpHelper.robloxDisplayName || mvpHelper.robloxUsername || 'Unknown';
        const mvpRobloxId = mvpHelper.robloxUserId || null;
        const mvpProfileUrl = mvpRobloxId
            ? 'https://www.roblox.com/users/' + mvpRobloxId + '/profile'
            : null;
        const mvpPfpUrl = mvpHelper.avatarUrl || DEFAULT_MVP_PFP_URL;

        contents.push(
            new SectionBuilder()
                .setThumbnailAccessory(
                    new ThumbnailBuilder()
                        .setURL(mvpPfpUrl)
                        .setDescription('MVP profile picture')
                )
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    DOT + ' ' + MVP_EMOJI + ' **Raid MVP:** **' + mvpName + '**' + NL +
                    DOT + ' **Roblox:** ' + (mvpProfileUrl
                        ? '[' + mvpName + ' (' + (mvpHelper.robloxUsername || mvpName) + ')](' + mvpProfileUrl + ')'
                        : (mvpHelper.robloxUsername || mvpName)) + NL +
                    DOT + ' **Discord:** ' + (mvpHelper.userId ? '<@' + mvpHelper.userId + '>' : 'Unknown') + NL +
                    DOT + ' **Time Spent:** `' + rsm.formatTimeSpent(mvpHelper.timeSpentSeconds || 0) + '`'
                ))
                .toJSON()
        );
        contents.push(separator());
    }

    // --- Enemy / game / location / times / proof block ---
    const gameLabel = rsm.GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';
    const enemiesText = raid.enemyNames || 'None';

    const proofLinks = proofUrls.length > 0
        ? proofUrls.slice(0, 8)
            .map(function (url, index) { return '[Image ' + (index + 1) + '](' + url + ')'; })
            .join(' \u2022 ')
        : 'No raid pictures uploaded.';

    contents.push(text(
        DOT + ' **Enemy Clan:** `' + (raid.enemyClanNames || 'None') + '`' + NL +
        DOT + ' **Enemies — ' + (raid.enemyCount || 0) + ':** `' + enemiesText + '`' + NL +
        NL +
        DOT + ' **Game:** ' + gameLabel + NL +
        DOT + ' **Location:** `' + (raid.region || 'Unknown') + '`' + NL +
        DOT + ' **Started:** ' + formatDayTime(startedAtMs) + NL +
        DOT + ' **Ended:** ' + formatDayTime(endedAtMs) + NL +
        NL +
        DOT + ' **Raid Proof:** ' + proofLinks
    ));
    contents.push(separator());

    // --- Helpers section: each helper in its own TextDisplay with a native
    // Separator divider between helpers ---
    contents.push(text('### \uD83D\uDEE1\uFE0F HELPERS'));
    const helpers = Array.isArray(raid.helpers)
        ? raid.helpers.filter(h => typeof h === 'object' && h && h.userId)
        : [];
    if (helpers.length === 0) {
        contents.push(text('*No helpers joined this raid.*'));
    } else {
        helpers.forEach(function (helper, index) {
            const isMvp = helper.userId === raid.mvpUserId;
            const name = helper.robloxDisplayName || helper.robloxUsername || 'Unknown';
            const prefix = isMvp ? MVP_EMOJI + ' ' : '';
            contents.push(text(prefix + '**<@' + helper.userId + '>** — **' + name + '** — `' +
                rsm.formatTimeSpent(helper.timeSpentSeconds || 0) + '`'));
            if (index < helpers.length - 1) {
                contents.push(separator());
            }
        });
    }

    // --- Subtext footer ---
    contents.push(separator());
    contents.push(text('-# Kakuzu Raid Network \u00B7 Raid #' + raid.raidId +
        (submitterId ? ' \u00B7 Result submitted by <@' + submitterId + '>' : '')));

    container.components = contents;

    return {
        flags: RAID_RESULT_V2_FLAGS,
        components: [container]
    };
}

/**
 * Classic-embed fallback used ONLY when Discord rejects the V2 payload
 * (Components V2 is a beta that must be enabled for the bot).
 */
function buildResultFallbackEmbed(opts) {
    const raid = opts.raid || {};
    const outcome = opts.outcome || 'win';
    const submitterId = opts.submitterId || raid.closedBy || null;
    const rallyPicUrl = opts.rallyPicUrl || null;
    const proofUrls = Array.isArray(opts.proofUrls) ? opts.proofUrls : [];
    const streakMessage = opts.streakMessage || null;
    const endedAtMs = opts.endedAtMs || raid.closedAt || Date.now();
    const startedAtMs = Number(raid.createdAt) || endedAtMs;
    const gameLabel = rsm.GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';

    const style = getOutcomeStyle(outcome);
    const embed = new EmbedBuilder()
        .setTitle('\uD83C\uDFC6 ' + style.title + ' — Raid #' + raid.raidId)
        .setColor(RESULT_NEUTRAL_COLOR)
        .setTimestamp(new Date(endedAtMs));

    if (rallyPicUrl) embed.setImage(rallyPicUrl);
    if (streakMessage) embed.setDescription(streakMessage);

    const rosterValue = Array.isArray(raid.helpers) && raid.helpers.length > 0
        ? raid.helpers
            .filter(h => typeof h === 'object' && h && h.userId)
            .map(h => (h.userId === raid.mvpUserId ? '\uD83C\uDFC6 ' : '\u2705 ') +
                '<@' + h.userId + '> (Roblox: ' + (h.robloxUsername || h.robloxDisplayName || 'Unknown') + ') ' +
                '\u23F1\uFE0F Time Spent: ' + rsm.formatTimeSpent(h.timeSpentSeconds || 0))
            .join('\n')
        : 'No operators deployed.';

    embed.addFields([
        { name: 'Operation Registry', value: '`#' + raid.raidId + '`', inline: true },
        { name: 'Squad Leader', value: raid.requesterId ? '<@' + raid.requesterId + '>' : 'Unknown', inline: true },
        { name: 'Ended By', value: submitterId ? '<@' + submitterId + '>' : 'Unknown', inline: true },
        { name: 'Region Server', value: '`' + (raid.region || 'Unknown') + '`', inline: true },
        { name: 'Operation Game', value: '`' + gameLabel + '`', inline: true },
        { name: 'Hostile Count', value: '`' + (raid.enemyCount || 0) + '`', inline: true },
        { name: 'Hostile Names', value: raid.enemyNames ? '`' + raid.enemyNames + '`' : '`None`', inline: true },
        { name: 'Hostile Grouping', value: raid.enemyClanNames ? '`' + raid.enemyClanNames + '`' : '`None`', inline: true },
        { name: 'Deployment Squad Roster', value: rosterValue, inline: false }
    ]);

    if (proofUrls.length > 0) {
        const picsValue = proofUrls.slice(0, 8).map((url, index) => (index + 1) + '. ' + url).join('\n');
        embed.addFields({ name: 'Raid Proof', value: picsValue.length > 1024 ? picsValue.slice(0, 1020) + '...' : picsValue, inline: false });
    } else {
        embed.addFields({ name: 'Raid Proof', value: 'No raid pictures uploaded.', inline: false });
    }

    return embed;
}

/**
 * Simple "no result" note embed for the 🚫 No Result outcome — posted to the
 * configured result channel instead of a full result card. No streaks or
 * metrics are recorded.
 */
function buildNoResultEmbed(opts) {
    const raid = opts.raid || {};
    const closedById = opts.closedById || raid.closedBy || null;
    const embed = new EmbedBuilder()
        .setTitle('\uD83D\uDED1 NO RAID RESULTS RECORDED')
        .setColor(0x888888)
        .setDescription(
            '> \uD83D\uDCDD **Note:** Raid `#' + raid.raidId + '` was closed without a result card.' + NL +
            '> No outcome, streaks or raid metrics were recorded for this deployment.'
        )
        .addFields(
            { name: 'Raid', value: '`#' + raid.raidId + '`', inline: true },
            { name: 'Requested By', value: raid.requesterId ? '<@' + raid.requesterId + '>' : 'Unknown', inline: true },
            { name: 'Closed By', value: closedById ? '<@' + closedById + '>' : 'Unknown', inline: true }
        )
        .setTimestamp();
    return embed;
}

module.exports = {
    RAID_RESULT_V2_FLAGS: RAID_RESULT_V2_FLAGS,
    OUTCOME_STYLES: OUTCOME_STYLES,
    DEFAULT_BANNER_IMAGE: DEFAULT_BANNER_IMAGE,
    buildResultCardPayload: buildResultCardPayload,
    buildResultFallbackEmbed: buildResultFallbackEmbed,
    buildNoResultEmbed: buildNoResultEmbed
};
