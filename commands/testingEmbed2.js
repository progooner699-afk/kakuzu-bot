'use strict';

/*
 * /testing-embed-2 — standalone support-server test command.
 *
 * WHAT IT DOES: fetches a raid through the SAME logic the raid RESULT flow
 * uses (raidStateManager.getRaidById + the identical field extraction as
 * handlers/raidResultCard.buildResultCardPayload: placeId, serverId/jobId,
 * region/country, timestamps, duration, stats, requester, helpers, MVP) and
 * renders the data as plain text inside a ```text code block instead of a
 * rich embed / Components V2 card. The existing raid result card, its embed
 * code and its button/modal handlers are NOT modified.
 *
 * DEPLOYMENT (strict): never registered globally. The exported `guildIds`
 * allowlist makes commandHandler.getCommandDataArray(guildId) include this
 * command ONLY for the Kakuzu Support server, so it is registered exclusively
 * through rest.Routes.applicationGuildCommands(clientId, guildId) — see
 * commands/deploy-commands.js. (Discord forbids spaces in command names, so
 * the registered name is `testing-embed-2`, not "testing embed 2".)
 *
 * SOURCE GUILD: raids live in MEMBER servers, not the support server, so the
 * optional `guild_id` option selects the source guild's raid store; it
 * defaults to the invoking guild. `guild_id` is strictly validated (digits
 * only) before it can reach any data path.
 */

const { SlashCommandBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');
// formatDayTime is the SAME timestamp formatter the result card renders with
// (purely re-exported; no embed code was changed).
const raidResultCard = require('../handlers/raidResultCard');

// Kakuzu Support server — the ONLY guild this command may be registered in.
const SUPPORT_GUILD_ID = '1536031049774010408';

// Discord hard-caps message content at 2000 characters (fences included).
const MAX_CONTENT_LENGTH = 2000;
const FENCE = '```';
// Space reserved inside the block for an "... (+N omitted)" note.
const OMIT_RESERVE = 100;
// Safety cap per value so one pathological field can never blow the budget.
const MAX_VALUE_LENGTH = 800;

// Plain outcome labels for the dump (the V2 card's OUTCOME_STYLES carry
// custom-emoji markdown that renders as raw noise inside a code block).
const OUTCOME_LABELS = {
    win: 'WIN',
    whooped: 'WHOOPED',
    loss: 'LOSS',
    noresult: 'NO RESULT',
    indeterminate: 'INDETERMINATE (no result recorded)'
};

/**
 * Prepares one data value for a code-block line: never lets a stray
 * backtick break the fence, flattens newlines, caps pathological lengths.
 * @param {*} value
 * @returns {string}
 */
function sanitize(value) {
    if (value == null || value === '') return 'None';
    let text = String(value)
        .replace(/`/g, "'")
        .replace(/\r?\n/g, ' ')
        .trim();
    if (!text) return 'None';
    if (text.length > MAX_VALUE_LENGTH) text = text.slice(0, MAX_VALUE_LENGTH) + '… (truncated)';
    return text;
}

function formatLine(label, value) {
    return label + ': ' + sanitize(value);
}

/**
 * Builds the SAME data the raid result card renders, as `Key: value` lines.
 * Field extraction mirrors handlers/raidResultCard.buildResultCardPayload:
 *   endedAtMs   = raid.closedAt || now
 *   startedAtMs = Number(raid.createdAt) || endedAtMs
 *   duration    = (endedAtMs - startedAtMs)/1000 via rsm.formatTimeSpent
 *   game label  = rsm.GAME_CONFIG[raid.targetGame]
 *   country     = rsm.countryCodeToName(raid.countryCode)
 *   MVP/helpers = raid.helpers filtered exactly like the HELPERS section
 * @param {object} raid raidStateManager raid record
 * @returns {{ coreLines: string[], helperLines: string[] }}
 */
function buildResultDataLines(raid) {
    const endedAtMs = raid.closedAt || Date.now();
    const startedAtMs = Number(raid.createdAt) || endedAtMs;
    const durationSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
    const gameLabel = raidStateManager.GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';
    const helpers = Array.isArray(raid.helpers)
        ? raid.helpers.filter(h => typeof h === 'object' && h && h.userId)
        : [];
    const mvp = helpers.find(h => h.userId === raid.mvpUserId) || null;
    const totalHelperSeconds = helpers.reduce((sum, h) => sum + (Number(h.timeSpentSeconds) || 0), 0);

    const coreLines = [
        '[RAID RESULT DATA]',
        formatLine('Raid ID', '#' + raidStateManager.getRaidDisplayId(raid) + ' (internal #' + raid.raidId + ')'),
        formatLine('Status', raid.status || 'Unknown'),
        formatLine('Outcome', (raid.outcome || 'none') + ' -> ' + (OUTCOME_LABELS[raid.outcome] || 'NONE')),
        formatLine('Game', gameLabel),
        formatLine('Place ID', raid.placeId),
        formatLine('Job ID', raid.serverId),
        formatLine('Server Link', raid.serverLink),
        formatLine('Region', raid.region || 'Unknown'),
        formatLine('Country', raid.countryCode
            ? raidStateManager.countryCodeToName(raid.countryCode) + ' (' + String(raid.countryCode).toUpperCase() + ')'
            : 'Unknown'),
        formatLine('Requester', raid.requesterId ? '<@' + raid.requesterId + '>' : 'Unknown'),
        formatLine('Requester Tag', raid.requesterTag || 'Unknown'),
        formatLine('Requester Roblox', raid.robloxUsername || raid.robloxDisplayName || 'Unknown'),
        formatLine('Requested At', raidResultCard.formatDayTime(startedAtMs)),
        formatLine('Ended At', raid.closedAt ? raidResultCard.formatDayTime(endedAtMs) : 'Not closed yet'),
        formatLine('Duration', raidStateManager.formatTimeSpent(durationSeconds)),
        formatLine('Ended By', raid.closedBy
            ? '<@' + raid.closedBy + '>' + (raid.closedByTag ? ' (' + raid.closedByTag + ')' : '')
            : 'Not closed yet'),
        formatLine('Close Reason', raid.closeReason || raid.reason),
        formatLine('Enemy Count', raid.enemyCount || 0),
        formatLine('Enemy Names', raid.enemyNames),
        formatLine('Enemy Clan', raid.enemyClanNames),
        formatLine('Helper Limit', raid.helperLimit || 0),
        formatLine('Helpers Joined', helpers.length),
        formatLine('Total Helper Time', helpers.length ? raidStateManager.formatTimeSpent(totalHelperSeconds) : '0s'),
        formatLine('MVP', mvp
            ? '<@' + mvp.userId + '> (' + (mvp.robloxDisplayName || mvp.robloxUsername || 'Unknown') + ') - ' +
                raidStateManager.formatTimeSpent(mvp.timeSpentSeconds || 0)
            : (raid.mvpUserId ? '<@' + raid.mvpUserId + '>' : 'None')),
        formatLine('Alert Channel', raid.channelId),
        formatLine('Alert Message', raid.messageId),
        '--- HELPERS ---'
    ];

    const helperLines = helpers.map(h => {
        const parts = [
            (h.userId === raid.mvpUserId ? '[MVP] ' : '') + '<@' + h.userId + '>',
            sanitize(h.robloxDisplayName || h.robloxUsername || 'Unknown'),
            'time: ' + raidStateManager.formatTimeSpent(h.timeSpentSeconds || 0)
        ];
        if (h.joinedAt != null) parts.push('joined: ' + h.joinedAt);
        if (h.leaveTime != null) parts.push('left: ' + h.leaveTime);
        return parts.join(' | ');
    });
    if (helperLines.length === 0) helperLines.push('None');

    return { coreLines, helperLines };
}

/**
 * Wraps the lines in a single ```text fenced block that ALWAYS fits inside
 * Discord's 2000-character message-content cap. Helper lines are dropped
 * first (with an explicit "... (+N omitted)" note inside the box); the
 * returned string is hard-guaranteed <= MAX_CONTENT_LENGTH characters.
 * @param {string[]} coreLines
 * @param {string[]} helperLines
 * @returns {string}
 */
function buildCodeBlock(coreLines, helperLines) {
    const header = FENCE + 'text\n';
    const footer = '\n' + FENCE;
    const budget = MAX_CONTENT_LENGTH - header.length - footer.length;
    const lineCap = budget - OMIT_RESERVE; // always keep room for the note

    const lines = [];
    let used = 0;
    let omittedCore = 0;
    let omittedHelpers = 0;

    for (let i = 0; i < coreLines.length; i++) {
        const line = coreLines[i];
        if (used + line.length + 1 <= lineCap) {
            lines.push(line);
            used += line.length + 1;
        } else {
            omittedCore = coreLines.length - i;
            break;
        }
    }

    if (omittedCore === 0) {
        for (let i = 0; i < helperLines.length; i++) {
            const line = helperLines[i];
            if (used + line.length + 1 <= lineCap) {
                lines.push(line);
                used += line.length + 1;
            } else {
                omittedHelpers = helperLines.length - i;
                break;
            }
        }
    } else {
        omittedHelpers = helperLines.length;
    }

    if (omittedCore > 0) {
        lines.push('... (+' + omittedCore + ' more data lines omitted — Discord 2000-char message limit)');
    } else if (omittedHelpers > 0) {
        lines.push('... (+' + omittedHelpers + ' more helpers omitted — Discord 2000-char message limit)');
    }

    let body = lines.join('\n');
    if (body.length > budget) body = body.slice(0, budget); // last-resort guarantee
    return header + body + footer;
}

/**
 * /testing-embed-2 — dumps a raid result's data inside a ```text code block.
 * The interaction hub defers ephemerally first (default `deferFirst`), so the
 * final answer goes through editReply.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function execute(interaction) {
    const raidId = interaction.options.getInteger('raid_id', true);
    const sourceOption = interaction.options.getString('guild_id');
    const sourceGuildId = sourceOption ? String(sourceOption).trim() : '';

    // Digits-only BEFORE the value can reach any data path (raids are stored
    // under data/guilds/<guildId>/ — never allow path-shaped input).
    if (sourceOption && !/^\d{5,30}$/.test(sourceGuildId)) {
        return interaction.editReply({
            content: '❌ `guild_id` must be a numeric Discord server ID (digits only).'
        }).catch(() => null);
    }

    const guildId = sourceGuildId || interaction.guildId;
    const raid = raidStateManager.getRaidById(raidId, guildId);
    if (!raid) {
        return interaction.editReply({
            content: '❌ Raid `#' + raidId + '` not found in guild `' + guildId + '`.'
        }).catch(() => null);
    }

    const { coreLines, helperLines } = buildResultDataLines(raid);
    return interaction.editReply({
        content: buildCodeBlock(coreLines, helperLines),
        allowedMentions: { parse: [] }
    }).catch(() => null);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('testing-embed-2')
        .setDescription('Debug: dump a raid result\'s data inside a code block (support server only)')
        .addIntegerOption(option =>
            option.setName('raid_id')
                .setDescription('The raid ID to dump')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('guild_id')
                .setDescription('Source guild whose raids to search (defaults to this server)')
                .setRequired(false)
        ),
    execute,
    // GUILD-REGISTRATION ALLOWLIST — consumed by commandHandler.getCommandDataArray(guildId).
    // This command is NEVER part of a global payload and NEVER registered in
    // any guild except the Kakuzu Support server.
    guildIds: [SUPPORT_GUILD_ID],
    SUPPORT_GUILD_ID,
    buildResultDataLines,
    buildCodeBlock,
    sanitize
};


