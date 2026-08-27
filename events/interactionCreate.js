const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionsBitField,
    EmbedBuilder,
    ChannelType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require("discord.js");
const raidStateManager = require("../handlers/raidStateManager");
const raidV2 = require("../handlers/raidV2");
const robloxApi = require("../handlers/robloxApi");
const verificationDb = require("../handlers/verificationDb");
const { formatRobloxProfileValue } = require("../handlers/verificationHelpers");
const sharedPingDb = require("../handlers/sharedPingDb");
const pendingRaidApplications = new Map();
const pendingRegionSelections = new Map();
const pendingGameSelections = new Map();
const pendingRaidOutcomes = new Map();
const pendingServerLinks = new Map();
const pendingPlaceIds = new Map();
const pendingServerIds = new Map();
const pendingGameThumbnails = new Map();
const pendingCountryCodes = new Map();

// Region ping IDs are now configured per-guild via settings.regionPings

function safeGetTextInputValue(fields, customId, fallback) {
  try {
    return fields.getTextInputValue(customId);
  } catch (err) {
    if (err.code === 'ModalSubmitInteractionFieldNotFound') {
      return fallback !== undefined ? fallback : null;
    }
    throw err;
  }
}

// Whitelisted roles updated with Supreme Leader included
const RAID_CLOSE_ROLES = [
    'Administrator',
    'Management Supervisor',
    'Community Manager',
    'Senior Moderator',
    '?? ? SUPREME LEADER'
];

// Roles that can close raids / moderate are NO LONGER hardcoded by name.
// They are stored as role IDs in the persistent per-guild settings.json so they
// survive restarts and are never affected by role name changes. (The
// /verificationadminrole command that used to set these has been removed; the
// setting is still honored by canCloseRaid / canModerateVerification for
// backwards compatibility with existing server configs.)

function getVerificationAdminRoleIds(guildId) {
    try {
        const settings = raidStateManager.loadSettings(guildId) || {};
        const roles = Array.isArray(settings.verificationAdminRoles) ? settings.verificationAdminRoles : [];
        // Deduplicate and drop the @everyone role id (which equals the guild id).
        return [...new Set(roles)].filter(id => typeof id === 'string' && id.length && id !== guildId);
    } catch (err) {
        return [];
    }
}

// Builds a deduplicated staff ping from the configured verification-admin role
// IDs. Never pings @everyone/@here.
function getVerificationStaffPing(guildId) {
    const roleIds = getVerificationAdminRoleIds(guildId);
    const unique = [...new Set(roleIds)];
    return {
        roleIds: unique,
        mention: unique.length ? unique.map(id => `<@&${id}>`).join(' ') : null,
        allowedMentions: unique.length ? { roles: unique } : undefined
    };
}

function canCloseRaid(member, raid) {
    if (!member || !raid) return false;
    if (member.id === raid.requesterId) return true;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    const guildId = member.guild && member.guild.id;
    if (guildId) {
        // Users granted the configured verification/admin role (per guild settings).
        const roleIds = getVerificationAdminRoleIds(guildId);
        if (roleIds.some(id => member.roles.cache.has(id))) return true;
    }
    return member.roles.cache.some(role => RAID_CLOSE_ROLES.includes(role.name));
}

function canModerateVerification(member) {
    if (!member) return false;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    const guildId = member.guild && member.guild.id;
    if (!guildId) return false;
    const roleIds = getVerificationAdminRoleIds(guildId);
    return roleIds.some(id => member.roles.cache.has(id));
}

/**
 * Returns a mention for the guild's configured /link-roblox verification channel,
 * or null if none has been set up yet. It is persisted when an admin selects the
 * channel for the link embed, so guard messages can point users to the exact spot.
 */
function getVerificationChannelMention(guildId) {
    try {
        const settings = raidStateManager.loadSettings(guildId) || {};
        if (settings.verificationChannel) return `<#${settings.verificationChannel}>`;
    } catch (err) { /* ignore */ }
    return null;
}

function buildUnverifiedMessage(guildId) {
    const mention = getVerificationChannelMention(guildId);
    return mention
        ? `🔒 You are not verified! Please link your Roblox account in ${mention} first.`
        : '🔒 You are not verified! Please link your Roblox account using the Link Roblox embed first.';
}

/**
 * Builds the Roblox join URL for a raid (used by the public JOIN SERVER button
 * and the helper's ephemeral link button).
 * Discord Link-style buttons only accept http(s) URLs — a `roblox://` scheme is
 * rejected by the API and would make the whole alert message fail to post. So we
 * expose an https Roblox "start" link (the client redirects to the launcher) and
 * fall back to the stored HTTPS server link when no place id is available.
 */
function buildRobloxJoinLink(raid) {
    const placeId = raid && raid.placeId;
    if (placeId) {
        return `https://www.roblox.com/games/start?placeId=${placeId}`;
    }
    const fallback = (raid && raid.serverLink) ? raid.serverLink : null;
    return fallback && /^https?:\/\//i.test(fallback) ? fallback : null;
}

function normalizeRegion(region) {
    const value = String(region || '').trim().toUpperCase();
    if (value === 'AS') return 'ASIA';
    if (value === 'EUROPE') return 'EU';
    if (value === 'US' || value === 'USA' || value === 'NORTH AMERICA') return 'NA';
    if (value === 'SOUTH AMERICA') return 'SA';
    if (value === 'AUS' || value === 'AUSTRALIA') return 'AUST';
    if (value === 'MIDDLE' || value === 'MIDDLE EAST' || value === 'MIDDLE_EAST') return 'MIDDLE_EAST';
    if (value === 'AFRICA') return 'AFRICA';
    if (value === 'OCEANIA' || value === 'OC' || value === 'OCE') return 'OCEANIA';
    return value;
}

function getRegionRoleInfo(guildId, region) {
    const normalized = normalizeRegion(region);
    try {
        const settings = raidStateManager.loadSettings(guildId) || {};
        const mapping = settings.regionPings || {};
        const roleIds = Array.isArray(mapping[normalized]) ? mapping[normalized].filter(Boolean) : [];
        const mention = roleIds.length ? roleIds.map(id => `<@&${id}>`).join(' ') : null;
        const allowedMentions = roleIds.length ? { roles: roleIds } : undefined;
        return { roleIds, mention, roleId: roleIds.length === 1 ? roleIds[0] : null, allowedMentions };
    } catch (err) {
        return { roleIds: [], mention: null, roleId: null, allowedMentions: undefined };
    }
}

/**
 * A role id is usable when it is a non-empty string that differs from the
 * "empty role" sentinels (0 / @everyone).
 */
function isUsableRoleId(roleId) {
    return typeof roleId === 'string' && roleId.length > 0 && roleId !== '0' && roleId !== '@everyone';
}

/**
 * Validates that a role still exists in the current guild. Cache-first so the
 * hot raid-post path stays synchronous; a network fetch happens only on a
 * cache miss (rare).
 */
async function roleExistsInGuild(client, guildId, roleId) {
    if (!isUsableRoleId(roleId)) return false;
    const guild = client && guildId ? client.guilds.cache.get(guildId) : undefined;
    if (!guild) return false;
    if (guild.roles.cache.has(roleId)) return true;
    try {
        const role = await guild.roles.fetch(roleId).catch(() => null);
        return Boolean(role);
    } catch (err) {
        return false;
    }
}

/**
 * Resolves the single role to ping when a raid alert is posted.
 *
 * Ping selection (country code takes precedence, never both):
 *   1. If a `countryCode` was successfully detected -> ping ONLY that country's
 *      configured role. If that role is missing/deleted/invalid -> NO location
 *      ping at all (never fall back to the broad region role).
 *   2. If NO `countryCode` was detected -> ping ONLY the broad region role
 *      (e.g. ASIA / EU / NA / SA). If it is missing -> NO location ping.
 *
 * Config source: dashboard-owned shared PostgreSQL first
 *   (`getGuildPingSettings(guildId)` -> `countryPings` / `regionPings`); when it
 *   is empty/down the LEGACY settings.json `regionPings` fallback runs - but
 *   ONLY in the no-country-detected (region) path, so a detected country with a
 *   missing role still pings nothing.
 *
 * Never throws. Always returns { roleId, mention, allowedMentions, source }.
 */
async function getRaidPingInfo(client, guildId, { countryCode, region }) {
    const normalizedRegion = normalizeRegion(region);
    // A truthy country code means we are in "country-only" mode: a missing
    // country role must yield NO ping rather than bubbling down to a region.
    const cc = String(countryCode || '').trim().toUpperCase();
    const useCountryOnly = Boolean(cc);
    let resolvedPing = null;

    try {
        const cfg = await sharedPingDb.getGuildPingSettings(guildId);
        const countryPings = cfg.countryPings || {};
        const regionPings = cfg.regionPings || {};

        let roleId = null;
        let source = null;
        if (useCountryOnly) {
            // Country detected -> only the country role is ever considered. We do
            // NOT step down to a broad region role when it is missing/invalid.
            let candidate = countryPings[cc];
            if (Array.isArray(candidate)) candidate = candidate.length ? candidate[0] : null;
            if (isUsableRoleId(candidate)) { roleId = candidate; source = 'country'; }
        } else if (normalizedRegion) {
            // No country detected -> only the broad region role is considered.
            let candidate = regionPings[normalizedRegion];
            if (Array.isArray(candidate)) candidate = candidate.length ? candidate[0] : null;
            if (isUsableRoleId(candidate)) { roleId = candidate; source = 'region'; }
        }

        if (roleId && await roleExistsInGuild(client, guildId, roleId)) {
            resolvedPing = {
                roleId,
                mention: `<@&${roleId}>`,
                allowedMentions: { roles: [roleId] },
                source
            };
        }
    } catch (err) {
        console.warn('[raid ping] shared Postgres lookup failed - falling back to legacy regionPings:', (err && err.message) || err);
    }

    if (resolvedPing) return resolvedPing;

    // With a detected country, a missing country role means NO location ping.
    // Do not fall back to a broad-region ping (legacy or otherwise).
    if (useCountryOnly) {
        return { roleId: null, mention: null, allowedMentions: undefined, source: 'none' };
    }

    // Legacy fallback: settings.json regionPings (region-only path - kept until
    // /setregionping is removed in a later stage).
    const legacy = getRegionRoleInfo(guildId, region);
    return {
        roleId: legacy.roleId || null,
        mention: legacy.mention,
        allowedMentions: legacy.allowedMentions,
        source: 'legacy'
    };
}

function createRaidButtons(raid, member = null) {
    const components = [];

    // [ Help ] — green public button. Anyone can click; the bot replies with an
    // EPHEMERAL message containing the raid id and the server (deep) link so the
    // user can join the raid server themselves.
    components.push(
        new ButtonBuilder()
            .setCustomId(`raid_help_${raid.raidId}`)
            .setLabel('Help')
            .setStyle(ButtonStyle.Success)
    );

    // [ Edit ] — grey, restricted to requester/staff (same gate as Close). Opens a
    // modal to edit raid fields (Target, Enemy Clan, Description), then edits the
    // existing alert IN PLACE (no new embed/message is sent).
    if (canCloseRaid(member, raid)) {
        components.push(
            new ButtonBuilder()
                .setCustomId(`raid_edit_${raid.raidId}`)
                .setLabel('Edit')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(raid.status === "CLOSED")
        );
    }

    // Close — restricted to the requester / staff via canCloseRaid.
    if (canCloseRaid(member, raid)) {
        components.push(
            new ButtonBuilder()
                .setCustomId(`close_raid_${raid.raidId}`)
                .setLabel('CLOSE RAID')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(raid.status === "CLOSED")
        );
    }

    return new ActionRowBuilder().addComponents(components);
}
function createVerificationActionButtons(userId) {
    const acceptBtn = new ButtonBuilder()
        .setCustomId(`verify_accept_${userId}`)
        .setLabel("? Accept Verification")
        .setStyle(ButtonStyle.Success);

    const denyBtn = new ButtonBuilder()
        .setCustomId(`verify_deny_${userId}`)
        .setLabel("? Deny Verification")
        .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder().addComponents(acceptBtn, denyBtn);
}

function buildVerificationEmbed({ title, description, color, footerText, thumbnailUrl, imageUrl, fields = [], timestamp = new Date() }) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setFooter({ text: footerText })
        .setTimestamp(timestamp);

    if (fields.length) {
        embed.addFields(fields);
    }

    if (thumbnailUrl) {
        embed.setThumbnail(thumbnailUrl);
    }

    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    return embed;
}

function getVerificationFieldValue(value) {
    if (value === null || value === undefined) return '�';
    const stringValue = String(value).trim();
    return stringValue || '�';
}

async function getVerificationTargetChannel(client, configuredChannelId, fallbackChannel) {
    if (configuredChannelId) {
        const configuredChannel = await client.channels.fetch(configuredChannelId).catch(() => null);
        if (configuredChannel && configuredChannel.isTextBased()) {
            return configuredChannel;
        }
        console.warn(`Configured verification log channel ${configuredChannelId} is unavailable or not text-based.`);
        return null;
    }

    if (fallbackChannel && fallbackChannel.isTextBased()) {
        return fallbackChannel;
    }

    return null;
}

async function updateVerificationMessage(channel, targetUserId, embed, components = []) {
    if (!channel || !channel.isTextBased()) return null;

    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const targetMessage = messages.find(msg => {
            if (!msg.embeds?.length) return false;
            const embedData = msg.embeds[0].data;
            const hasTargetUser = embedData.description?.includes(`<@${targetUserId}>`) || embedData.description?.includes(targetUserId);
            const hasPendingStatus = embedData.title?.includes('PENDING') || embedData.title?.includes('ACCEPTED') || embedData.title?.includes('REJECTED');
            return hasTargetUser && hasPendingStatus;
        });

        if (!targetMessage) {
            return null;
        }

        await targetMessage.edit({ embeds: [embed], components });
        return targetMessage;
    } catch (error) {
        console.warn(`Could not update verification message in channel ${channel.id}: ${error.message}`);
        return null;
    }
}

async function editStoredVerificationMessage(client, verificationData, embed, components = []) {
    if (!verificationData?.log_channel_id || !verificationData?.log_message_id) {
        return null;
    }

    try {
        const channel = await client.channels.fetch(verificationData.log_channel_id).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            return null;
        }

        const message = await channel.messages.fetch(verificationData.log_message_id).catch(() => null);
        if (!message) {
            return updateVerificationMessage(channel, verificationData.userId, embed, components);
        }

        await message.edit({ embeds: [embed], components });
        return message;
    } catch (error) {
        console.warn(`Could not edit stored verification message: ${error.message}`);
        return null;
    }
}

// ===== Verification decision helpers =====

function formatVerificationDate(value) {
    if (!value) return new Date().toLocaleString();
    const d = new Date(Number(value));
    return Number.isNaN(d.getTime()) ? new Date().toLocaleString() : d.toLocaleString();
}

function getVerificationValues(verificationData, targetUserTag) {
    const psLink = verificationData?.roblox_ps_link || '';
    const friendList = verificationData?.friend_list_link || '';
    const profileValue = formatRobloxProfileValue({
        roblox_display_name: verificationData?.roblox_display_name || verificationData?.roblox_username,
        roblox_username: verificationData?.roblox_username,
        roblox_user_id: verificationData?.roblox_user_id
    });
    return {
        targetUserTag,
        robloxUsername: verificationData?.roblox_username || verificationData?.roblox_display_name || 'Unknown',
        robloxProfileValue: profileValue || 'Not linked',
        robloxAvatarUrl: verificationData?.roblox_avatar_url || null,
        killCount: verificationData?.kill_count || 'N/A',
        psLink: /^https?:\/\/.+/i.test(psLink) ? `[View PS](${psLink})` : (psLink || 'Not provided'),
        friendList: /^https?:\/\/.+/i.test(friendList) ? `[View Screenshot](${friendList})` : 'Not provided',
        verificationId: verificationData?.verification_id || 'Unknown'
    };
}

function buildAcceptedEmbed({ values, reviewerTag, reviewedAt, guild }) {
    return buildVerificationEmbed({
        title: '??? PLAYER VERIFIED ???',
        description: '> ?? **CONGRATULATIONS!** ??\nYour verification request has been **approved**.\nWelcome to the clan � we\'re thrilled to have you aboard! ??',
        color: 0x2ECC71,
        footerText: `?? Kakuzu Verification System � ? Approved at ${reviewedAt}`,
        thumbnailUrl: values.robloxAvatarUrl || guild.iconURL({ size: 256 }),
        imageUrl: null,
        fields: [
            { name: '?? Player', value: values.targetUserTag, inline: false },
            { name: '?? Roblox Profile', value: getVerificationFieldValue(values.robloxProfileValue), inline: true },
            { name: '?? Kill Count', value: getVerificationFieldValue(values.killCount), inline: true },
            { name: '?? PS Link', value: getVerificationFieldValue(values.psLink), inline: true },
            { name: '??? Friend List', value: getVerificationFieldValue(values.friendList), inline: false },
            { name: '?? Status', value: '? **ACCEPTED**', inline: true },
            { name: '????? Verified By', value: reviewerTag, inline: true },
            { name: '??? Verification ID', value: getVerificationFieldValue(values.verificationId), inline: true },
            { name: '?? Verified At', value: reviewedAt, inline: false }
        ]
    });
}

function buildRejectedEmbed({ values, reviewerTag, reviewedAt, guild, reason }) {
    return buildVerificationEmbed({
        title: '? PLAYER VERIFICATION REJECTED',
        description: '> ?? Unfortunately, your verification request was **rejected** by the verification staff.\nPlease review the reason below � you are welcome to try again later. ??',
        color: 0xE74C3C,
        footerText: `?? Kakuzu Verification System � ? Rejected at ${reviewedAt}`,
        thumbnailUrl: values.robloxAvatarUrl || guild.iconURL({ size: 256 }),
        imageUrl: null,
        fields: [
            { name: '?? Player', value: values.targetUserTag, inline: false },
            { name: '?? Roblox Profile', value: getVerificationFieldValue(values.robloxProfileValue), inline: true },
            { name: '?? Kill Count', value: getVerificationFieldValue(values.killCount), inline: true },
            { name: '?? PS Link', value: getVerificationFieldValue(values.psLink), inline: true },
            { name: '??? Friend List', value: getVerificationFieldValue(values.friendList), inline: false },
            { name: '?? Reason', value: getVerificationFieldValue(reason), inline: false },
            { name: '?? Status', value: '? **REJECTED**', inline: true },
            { name: '????? Rejected By', value: reviewerTag, inline: true },
            { name: '??? Verification ID', value: getVerificationFieldValue(values.verificationId), inline: true },
            { name: '?? Rejected At', value: reviewedAt, inline: false }
        ]
    });
}

async function sendVerificationResult(client, guildId, targetUserId, embed) {
    const settings = raidStateManager.loadSettings(guildId);
    if (!settings.verificationResultChannel) {
        console.warn(`No verification result channel configured for guild ${guildId}.`);
        return false;
    }
    const channel = await client.channels.fetch(settings.verificationResultChannel).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        console.warn(`Verification result channel ${settings.verificationResultChannel} unavailable for guild ${guildId}.`);
        return false;
    }
    await channel.send({ content: `<@${targetUserId}>`, embeds: [embed] }).catch(err => {
        console.warn(`Could not send verification result to result channel: ${err.message}`);
    });
    return true;
}

async function sendVerificationDM(client, targetUserId, embed) {
    try {
        const targetUser = await client.users.fetch(targetUserId).catch(() => null);
        if (!targetUser) return { delivered: false, reason: 'User not found' };
        await targetUser.send({ embeds: [embed] }).catch(() => {
            throw new Error('DM blocked or disabled');
        });
        return { delivered: true };
    } catch (error) {
        return { delivered: false, reason: error.message };
    }
}

async function finalizeRaidOutcome(interaction, raid, outcome) {
    const settings = raidStateManager.loadSettings(interaction.guild.id);
    const raidsData = raidStateManager.loadRaids(interaction.guild.id);

    let resultTitle, resultColor, descriptionText;
    if (outcome === 'win' || outcome === 'whooped') {
        if (raidsData.streakType === 'WIN') {
            raidsData.streakCount += 1;
        } else {
            raidsData.streakType = 'WIN';
            raidsData.streakCount = 1;
        }
        if (outcome === 'whooped') {
            resultTitle = '?? OBLITERATION DEPLOYMENT (WHOOPED) ??';
            resultColor = 0xff0055;
            descriptionText = `Our combat deployment completely **WHOOPED** the opposition forces! A flawless victory.`;
        } else {
            resultTitle = '?? OPERATION VICTORY ??';
            resultColor = 0x00ff66;
            descriptionText = `Our active deployment successfully secured a decisive combat victory!`;
        }
    } else if (outcome === 'loss') {
        if (raidsData.streakType === 'LOSS') {
            raidsData.streakCount += 1;
        } else {
            raidsData.streakType = 'LOSS';
            raidsData.streakCount = 1;
        }
        resultTitle = '? DEPLOYMENT LOSS ?';
        resultColor = 0xff3333;
        descriptionText = `Our combat crew suffered an operational defeat against enemy forces during deployment.`;
    } else {
        resultTitle = '?? INDECISIVE CONCLUSION / CAN\'T SAY ??';
        resultColor = 0x888888;
        descriptionText = `The combat operation concluded indeterminately, or was cancelled mid-deployment.`;
    }

    raidStateManager.saveRaids(interaction.guild.id, raidsData);

    const streakMessage = raidsData.streakCount > 0
        ? `**Current Streak:** ${raidsData.streakType === 'WIN' ? '??' : '??'} ${raidsData.streakCount} Matches consecutive!`
        : '**Current Streak:** None tracking';

    const gameLabel = raidStateManager.GAME_CONFIG[raid.targetGame] || raid.targetGame || 'Unknown';
    const mvpUserId = raid.mvpUserId;

    const buildReportCardEmbed = (attachments = []) => {
        const rosterValue = raid.helpers && raid.helpers.length > 0
            ? raid.helpers.map(h => {
                const helperUserId = typeof h === 'string' ? h : h.userId;
                const helperRobloxUsername = typeof h === 'string' ? 'Unknown' : (h.robloxUsername || 'Unknown');
                const timeSpent = typeof h === 'object' ? raidStateManager.formatTimeSpent(h.timeSpentSeconds || 0) : '0m 0s';
                const isMvp = helperUserId === mvpUserId;
                const prefix = isMvp ? '🏆 MVP: ' : '✅ ';
                return `${prefix}<@${helperUserId}> (Roblox: ${helperRobloxUsername}) ⏱️ Time Spent: ${timeSpent}`;
            }).join('\n')
            : 'No operators deployed.';

        const embed = new EmbedBuilder()
            .setTitle(resultTitle)
            .setDescription(`${descriptionText}\n\n${streakMessage}`)
            .setColor(resultColor)
            .addFields([
                { name: 'Operation Registry', value: `\`#${raid.raidId}\``, inline: true },
                { name: 'Squad Leader', value: `<@${raid.requesterId}>`, inline: true },
                { name: 'Region Server', value: `\`${raid.region || 'Unknown'}\``, inline: true },
                { name: 'Operation Game', value: `\`${gameLabel}\``, inline: true },
                { name: 'Hostile Count', value: `\`${raid.enemyCount || 0}\``, inline: true },
                { name: 'Hostile Names', value: raid.enemyNames ? `\`${raid.enemyNames}\`` : (raid.enemyClanNames ? `\`${raid.enemyClanNames}\`` : '`None`'), inline: true },
                { name: 'Hostile Grouping', value: raid.enemyClanNames ? `\`${raid.enemyClanNames}\`` : '`None`', inline: true },
                { name: 'Deployment Squad Roster', value: rosterValue, inline: false }
            ])
            .setTimestamp();

        if (attachments.length > 0) {
            const picsValue = attachments.slice(0, 8).map((url, index) => `${index + 1}. ${url}`).join('\n');
            embed.addFields({ name: 'Pics', value: picsValue.length > 1024 ? `${picsValue.slice(0, 1020)}...` : picsValue, inline: false });
            embed.setImage(attachments[0]);
        } else {
            embed.addFields({ name: 'Pics', value: 'No pictures uploaded.', inline: false });
        }

        return embed;
    };

    const sendResultEmbed = async (attachments = []) => {
        if (settings.resultChannel) {
            const targetResultChannel = await interaction.client.channels.fetch(settings.resultChannel).catch(() => null);
            if (targetResultChannel && targetResultChannel.isTextBased()) {
                const regionRoleInfo = await getRaidPingInfo(interaction.client, interaction.guild.id, { countryCode: null, region: raid.region });
                await targetResultChannel.send({
                    content: regionRoleInfo.mention || undefined,
                    embeds: [buildReportCardEmbed(attachments)],
                    allowedMentions: regionRoleInfo.allowedMentions
                });
            }
        }
    };

    // Update the raid alert message in the channel
    try {
        const alertChannel = await interaction.client.channels.fetch(raid.channelId).catch(() => null);
        if (alertChannel && alertChannel.isTextBased()) {
            const baseAlertMsg = await alertChannel.messages.fetch(raid.messageId).catch(() => null);
            if (baseAlertMsg) {
                const updatedAlertEmbeds = raidStateManager.formatRaidMessage(raid, interaction.guild.id);
                const cleanClosedRow = createRaidButtons(raid, interaction.member);
                if (raid.alertFormat === 'v2') {
                    const payload = await raidV2.buildRaidAlertPayload(raid, cleanClosedRow);
                    await baseAlertMsg.edit({ components: payload.components }).catch(() => null);
                } else {
                    await baseAlertMsg.edit({ embeds: updatedAlertEmbeds, components: [cleanClosedRow] }).catch(() => null);
                }
            }
        }
    } catch (e) { /* ignore */ }


    let uploadedUrls = [];
    const guild = interaction.guild;
    let tempChannel = null;

    try {
        const parentId = interaction.channel?.parentId || null;
        tempChannel = await guild.channels.create({
            name: `raid-uploads-${raid.raidId}`,
            type: ChannelType.GuildText,
            parent: parentId || undefined,
            topic: `Temporary upload channel for raid #${raid.raidId}. Will be removed after collection.`
        });

        await interaction.followUp({ content: `?? Upload any pictures or files for this raid result in ${tempChannel} now. Reply with \`done\` in that channel when finished, or wait 60 seconds. The result will be posted to the configured result channel automatically.`, ephemeral: true }).catch(() => null);

        await tempChannel.send({ content: `?? **Upload pictures for Raid #${raid.raidId} here.**\nReply with \`done\` (by <@${interaction.user.id}>) when finished, or wait 60 seconds and the bot will post whatever was uploaded.` }).catch(() => null);

        const collector = tempChannel.createMessageCollector({
            filter: (msg) => {
                if (msg.content?.toLowerCase().trim() === 'done' && msg.author.id === interaction.user.id) return true;
                return msg.attachments && msg.attachments.size > 0;
            },
            time: 60000,
            max: 100
        });

        collector.on('collect', (msg) => {
            if (msg.attachments && msg.attachments.size > 0) {
                for (const attachment of msg.attachments.values()) {
                    uploadedUrls.push(attachment.url);
                }
            }
            if (msg.content?.toLowerCase().trim() === 'done' && msg.author.id === interaction.user.id) {
                collector.stop('done_by_user');
            }
        });

        collector.on('end', async () => {
            try {
                await sendResultEmbed(uploadedUrls);
            } catch (err) {
                console.warn('Failed to send result embed after collection:', err?.message || err);
            }
            setTimeout(async () => {
                try {
                    if (tempChannel && !tempChannel.deleted) await tempChannel.delete('Temporary raid upload channel expired');
                } catch (err) { /* ignore */ }
            }, 2000);
        });

        return;
    } catch (error) {
        console.warn('Could not create temporary upload channel, falling back to in-channel collector:', error?.message || error);
    }

    // Legacy fallback
    await interaction.followUp({ content: '?? Upload any pictures or files for this raid result in this channel. Reply with `done` when finished, or just wait 30 seconds. The result will be sent automatically after.', ephemeral: true }).catch(() => null);

    const collectorChannel = interaction.channel || await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    if (!collectorChannel || !collectorChannel.isTextBased()) {
        await sendResultEmbed(uploadedUrls);
        return;
    }

    const legacyCollector = collectorChannel.createMessageCollector({
        filter: (msg) => msg.author.id === interaction.user.id && msg.channelId === interaction.channelId,
        time: 30000,
        max: 20
    });

    legacyCollector.on('collect', (msg) => {
        if (msg.attachments.size > 0) {
            for (const attachment of msg.attachments.values()) {
                uploadedUrls.push(attachment.url);
            }
        }
        const content = msg.content?.toLowerCase().trim();
        if (content === 'done') {
            legacyCollector.stop('done');
        }
    });

    legacyCollector.on('end', async () => {
        await sendResultEmbed(uploadedUrls);
    });
}

module.exports = {
    name: "interactionCreate",
    async execute(interaction) {
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) return;
            try {
                await command.execute(interaction);
            } catch (error) {
                const errMsg = (error && error.message) ? error.message : String(error);
                console.error(`Command execution error (/${interaction.commandName || 'unknown'}):`, error);
                // Show the real error in the ephemeral reply so failures are
                // visible instead of a generic message (aids diagnosis).
                const replyText = 'An error occurred while executing that command.' +
                    (errMsg ? '\n`' + errMsg.slice(0, 500) + '`' : '');
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: replyText, flags: 64 }).catch(() => null);
                } else {
                    await interaction.followUp({ content: replyText, flags: 64 }).catch(() => null);
                }
            }
            return;
        }

        // Handle request_raid button - auto-detect game/region/server
        if (interaction.customId === "request_raid") {
            await interaction.deferReply({ flags: 64 }).catch(() => null);

            const verificationData = await verificationDb.getVerificationData(interaction.user.id, interaction.guild.id);
            const isVerified = Boolean(verificationData?.is_verified && verificationData?.roblox_user_id);
            if (!isVerified) {
                return interaction.editReply({
                    content: buildUnverifiedMessage(interaction.guild.id),
                    flags: 64
                }).catch(() => null);
            }

            const robloxUserId = verificationData.roblox_user_id;
            const detection = await robloxApi.detectGameAndRegion(robloxUserId);

            if (!detection.success) {
                return interaction.editReply({
                    content: "Auto-Detection Failed: " + detection.error + ". Make sure you are in a Roblox game.",
                    flags: 64
                }).catch(() => null);
            }

            pendingGameSelections.set(interaction.user.id, detection.game);
            pendingRegionSelections.set(interaction.user.id, detection.region);
            pendingServerLinks.set(interaction.user.id, detection.serverLink || '');
            pendingPlaceIds.set(interaction.user.id, detection.placeId || '');
            pendingServerIds.set(interaction.user.id, detection.serverId || '');
            pendingGameThumbnails.set(interaction.user.id, detection.gameIconUrl || '');
            pendingCountryCodes.set(interaction.user.id, detection.countryCode || '');

            const openFormButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("open_raid_application")
                    .setLabel("⚔️ Open Raid Application Form")
                    .setStyle(ButtonStyle.Primary)
            );

            return interaction.editReply({
                content: "✅ Game & server detected! Click the button below to open the raid application form.",
                components: [openFormButton],
                flags: 64
            }).catch(() => null);
        }

        // Handle open_raid_application button - shows the modal (fast, no async work)
        if (interaction.customId === "open_raid_application") {
            const modal = new ModalBuilder()
                .setCustomId("raid_application_step1")
                .setTitle("Raid Request Application");

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("enemyNames")
                        .setLabel("Enemy Names")
                        .setPlaceholder("e.g., Player1, Player2, Player3")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("helperLimit")
                        .setLabel("Helpers Needed (1-20)")
                        .setPlaceholder("e.g., 3")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("enemyClanName")
                        .setLabel("Enemy Clan Name")
                        .setPlaceholder("Enter enemy clan name")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("reason")
                        .setLabel("Reason for Raid")
                        .setPlaceholder("Explain why you need help")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                )
            );

            return interaction.showModal(modal).catch(() => null);
        }

        // Handle channel selection for link embed
        if (interaction.customId === "select_link_channel") {
            const selectedChannel = interaction.channels.first();
            
            if (!selectedChannel) {
                return interaction.reply({
                    content: "Please select a valid channel.",
                    flags: 64
                }).catch(() => null);
            }

            // Create the link embed with button
            const linkEmbed = new EmbedBuilder()
                .setTitle('Link Your Roblox Account')
                .setDescription('Click the button below to link your Discord account with your Roblox username.\n\nYou will be prompted to enter your Roblox username from the button interaction, and your account will be verified for raid access.')
                .addFields([
                    { name: 'Instructions', value: '1. Click the "Link Roblox" button\n2. Enter your Roblox username in the popup\n3. Submit the form', inline: false },
                    { name: 'Benefits', value: '• Request raids\n• Accept raid operations\n• Full access to bot features', inline: false }
                ])
                .setColor(0x9B59B6)
                .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                .setTimestamp();

            const linkButton = new ButtonBuilder()
                .setCustomId('link_roblox')
                .setLabel('🔗 Link Roblox')
                .setStyle(ButtonStyle.Success);

            const buttonRow = new ActionRowBuilder().addComponents(linkButton);

            // Persist the chosen channel so unverified-user guard messages can
            // dynamically link to this exact spot for the /link-roblox embed.
            const linkSettings = raidStateManager.loadSettings(interaction.guild.id) || {};
            linkSettings.verificationChannel = selectedChannel.id;
            raidStateManager.saveSettings(interaction.guild.id, linkSettings);

            await interaction.reply({
                content: `Posting Roblox link embed in <#${selectedChannel.id}>`,
                flags: 64
            }).catch(() => null);

            await interaction.client.channels.fetch(selectedChannel.id).then(channel => {
                if (channel && channel.isTextBased()) {
                    channel.send({
                        embeds: [linkEmbed],
                        components: [buttonRow]
                    }).catch(err => console.error('Failed to send link embed:', err));
                }
            });
        }
        // Handle backup panel channel selection — post the panel through a
        // webhook named "backuppanel" (dummy profile with the branded avatar)
        // instead of the bot account itself.
        if (interaction.customId === "post_backuppanel") {
            const selectedChannel = interaction.channels.first();

            if (!selectedChannel) {
                return interaction.reply({
                    content: "Please select a valid channel.",
                    flags: 64
                }).catch(() => null);
            }

            if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({
                    content: "You need the **Manage Server** permission to post the backup panel.",
                    flags: 64
                }).catch(() => null);
            }

            await interaction.reply({
                content: `Posting the backup panel in <#${selectedChannel.id}>…`,
                flags: 64
            }).catch(() => null);

            try {
                const backupPanel = require("../commands/backuppanel");
                const targetChannel = await interaction.client.channels.fetch(selectedChannel.id);
                if (!targetChannel || !targetChannel.isTextBased()) {
                    throw new Error("The selected channel is not a text channel.");
                }

                // Find or create the dummy-profile webhook in the target channel.
                const avatarBuffer = backupPanel.getBackupPanelAvatarBuffer();
                const webhooks = await targetChannel.fetchWebhooks();
                let webhook = webhooks.find(w => w.name === backupPanel.BACKUP_PANEL_WEBHOOK_NAME);
                if (!webhook) {
                    webhook = await targetChannel.createWebhook({
                        name: backupPanel.BACKUP_PANEL_WEBHOOK_NAME,
                        avatar: avatarBuffer || undefined,
                        reason: `Backup panel dummy profile (created by ${interaction.user.tag})`
                    });
                } else if (!webhook.avatarURL() && avatarBuffer) {
                    // Existing webhook still has Discord's default avatar —
                    // apply the branded avatar once.
                    await webhook.edit({ avatar: avatarBuffer }).catch(() => null);
                }

                const payload = backupPanel.buildBackupPanelPayload();
                await webhook.send({
                    ...payload,
                    username: backupPanel.BACKUP_PANEL_WEBHOOK_NAME
                });

                await interaction.editReply({
                    content: `✅ Backup panel posted in <#${selectedChannel.id}> via the **${backupPanel.BACKUP_PANEL_WEBHOOK_NAME}** profile.`
                }).catch(() => null);
            } catch (err) {
                console.error("Failed to post backup panel:", err);
                const errText = '❌ Failed to post the backup panel: `' +
                    String((err && err.message) || err).slice(0, 300) + '`';
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: errText }).catch(() => null);
                } else {
                    await interaction.reply({ content: errText, flags: 64 }).catch(() => null);
                }
            }
            return;
        }

        // Handle link roblox button click - open modal
        if (interaction.customId === "link_roblox") {
            const modal = new ModalBuilder()
                .setCustomId("link_roblox_modal")
                .setTitle("Link Roblox Account");

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("roblox_username")
                        .setLabel("Roblox Username")
                        .setPlaceholder("Enter your exact Roblox username")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                )
            );

            return interaction.showModal(modal).catch(() => null);
        }

        // Handle link roblox modal submission
        if (interaction.customId === "link_roblox_modal") {
            const robloxUsername = interaction.fields.getTextInputValue("roblox_username").trim();
            const guildId = interaction.guild?.id;

            if (!guildId) {
                return interaction.reply({
                    content: 'This command can only be used inside a server.',
                    flags: 64
                });
            }

            // Check if already verified
            const existing = await verificationDb.getVerificationData(interaction.user.id, guildId);
            if (existing && existing.is_verified) {
                const alreadyVerifiedEmbed = new EmbedBuilder()
                    .setTitle('Already Verified')
                    .setDescription('Your Roblox account is already linked and verified. You are authorized to request raids and accept operations.')
                    .setColor(0x9B59B6)
                    .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                    .setTimestamp();

                return interaction.reply({ embeds: [alreadyVerifiedEmbed], flags: 64 });
            }

            // Validate the Roblox username
            const validation = await robloxApi.validateAndGetAvatar(robloxUsername);
            if (!validation.success) {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('Roblox Username Validation Failed')
                    .setDescription(`\`\`\`\n${validation.error}\n\`\`\`\nPlease double-check your Roblox username spelling and try again.`)
                    .setColor(0xE74C3C)
                    .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                    .setTimestamp();

                return interaction.reply({ embeds: [errorEmbed], flags: 64 });
            }

            const robloxUserId = validation.userId;
            const robloxDisplayName = validation.displayName;
            const robloxAvatarUrl = validation.avatarUrl;
            const profileLink = `https://www.roblox.com/users/${robloxUserId}/profile`;

            // Save the verification
            await verificationDb.directLink(interaction.user.id, {
                robloxUsername,
                robloxDisplayName,
                robloxUserId,
                robloxAvatarUrl,
                robloxPsLink: null,
                killCount: null,
                friendListLink: null,
                verificationId: null
            }, guildId);

            const successEmbed = new EmbedBuilder()
                .setTitle('Roblox Account Linked')
                .setDescription(`✅ Successfully linked as ${robloxDisplayName}!`)
                .addFields([
                    { name: 'Roblox Profile', value: `[${robloxDisplayName} (@${robloxUsername})](${profileLink})`, inline: false },
                    { name: 'Roblox User ID', value: `\`${robloxUserId}\``, inline: true },
                    { name: 'Verification Status', value: 'Verified', inline: true },
                    { name: 'Raid Access', value: 'Granted', inline: true }
                ])
                .setColor(0x9B59B6)
                .setThumbnail(robloxAvatarUrl || interaction.client.user.displayAvatarURL({ size: 64 }))
                .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                .setTimestamp();

            await interaction.reply({ embeds: [successEmbed], flags: 64 });
        }

        if (interaction.customId === "raid_application_step1") {
            const userId = interaction.user.id;
            const guildId = interaction.guild.id;
            raidStateManager.cleanupPendingRaids(userId, guildId);
            if (!raidStateManager.canCreateRaid(userId, guildId)) {
                return interaction.reply({ content: "You already have an open raid. Close the existing raid first.", flags: 64 }).catch(() => null);
            }

            const game = pendingGameSelections.get(userId);
            const region = pendingRegionSelections.get(userId);
            const serverLink = pendingServerLinks.get(userId) || '';
            const placeId = pendingPlaceIds.get(userId) || '';
            const serverId = pendingServerIds.get(userId) || '';
            const gameThumbnailUrl = pendingGameThumbnails.get(userId) || '';
            const countryCode = pendingCountryCodes.get(userId) || '';
            
            if (!game || !region) {
                pendingGameSelections.delete(userId);
                pendingRegionSelections.delete(userId);
                return interaction.reply({ content: "Game detection expired. Please try again.", flags: 64 }).catch(() => null);
            }

            const enemyNamesInput = interaction.fields.getTextInputValue("enemyNames").trim();
            const helperLimit = Number(interaction.fields.getTextInputValue("helperLimit"));
            const enemyClanName = interaction.fields.getTextInputValue("enemyClanName").trim();
            const reason = interaction.fields.getTextInputValue("reason");

            if (!enemyNamesInput) {
                return interaction.reply({ content: "Please enter the enemy names.", flags: 64 }).catch(() => null);
            }
            if (Number.isNaN(helperLimit) || helperLimit < 1 || helperLimit > 20) {
                return interaction.reply({ content: "Helpers needed must be a number between 1 and 20.", flags: 64 }).catch(() => null);
            }

            const enemyNames = enemyNamesInput.split(',').map(n => n.trim()).filter(Boolean);

            pendingGameSelections.delete(userId);
            pendingRegionSelections.delete(userId);
            pendingServerLinks.delete(userId);
            pendingPlaceIds.delete(userId);
            pendingServerIds.delete(userId);
            pendingGameThumbnails.delete(userId);
            pendingCountryCodes.delete(userId);

            const verificationData = await verificationDb.getVerificationData(userId, interaction.guild.id);
            const robloxUsername = verificationData?.roblox_username || 'Unknown';
            const robloxDisplayName = verificationData?.roblox_display_name || robloxUsername;
            const robloxUserId = verificationData?.roblox_user_id || "1";
            const robloxAvatarUrl = verificationData?.roblox_avatar_url || null;

            const raid = raidStateManager.createRaid({
                requesterId: userId,
                requesterTag: interaction.user.tag,
                targetGame: game,
                robloxUsername,
                robloxDisplayName,
                robloxUserId,
                robloxAvatarUrl,
                serverLink,
                placeId,
                serverId,
                gameThumbnailUrl,
                region,
                countryCode,
                enemyCount: enemyNames.length,
                enemyClanNames: enemyClanName,
                enemyNames: enemyNames.join(', '),
                enemyClanPresent: 'NO',
                reason,
                helperLimit,
                guildId: interaction.guild.id,
                draft: true
            });

            const settings = raidStateManager.loadSettings(guildId);
            const embeds = raidStateManager.formatRaidMessage(raid, guildId);
            const raidButtonRow = createRaidButtons(raid, interaction.member);
            const regionRoleInfo = await getRaidPingInfo(interaction.client, guildId, { countryCode, region });

            if (!settings.raidChannel) {
                return interaction.reply({ content: 'Raid channel is not configured. Please run `/setchannels` and set the `raid_channel` first (Raid Alert channel).', flags: 64 }).catch(() => null);
            }

            const targetChannel = await interaction.client.channels.fetch(settings.raidChannel).catch(() => null);

            if (!targetChannel || !targetChannel.isTextBased()) {
                return interaction.reply({ content: 'Configured raid channel is unavailable or not a text channel. Please reconfigure it with `/setchannels`.', flags: 64 }).catch(() => null);
            }

            const completionEmbed = new EmbedBuilder()
                .setTitle('Raid Request Successfully Launched!')
                .setDescription(`Operator <@${userId}> has successfully deployed a combat request!`)
                .addFields([
                    { name: 'Raid Registry ID', value: `\`#${raid.raidId}\``, inline: true },
                    { name: 'Roblox Identity', value: `\`${robloxUsername}\``, inline: true },
                    { name: 'Target Game', value: `\`${raidStateManager.GAME_CONFIG[game] || game}\``, inline: true },
                    { name: 'Target Region', value: `\`${region}\``, inline: true }
                ])
                .setColor(0x00ff66)
                .setTimestamp();

            await interaction.reply({ embeds: [completionEmbed], flags: 64 }).catch(() => null);

            try {
                const v2Payload = await raidV2.buildRaidAlertPayload(raid, raidButtonRow);
                if (regionRoleInfo.mention) {
                    await targetChannel.send({ content: regionRoleInfo.mention, allowedMentions: regionRoleInfo.allowedMentions }).catch(() => null);
                }
                const v2Message = await targetChannel.send(v2Payload);
                raidV2.markAlertV2(raid.raidId, guildId);
                raidStateManager.setRaidOpen(raid.raidId, guildId);
                raidStateManager.updateRaidMessageReference(raid.raidId, targetChannel.id, v2Message.id, guildId);
            } catch (err) {
                console.warn('Components V2 alert failed, falling back to embed:', (err && err.message) || err);
                try {
                    const message = await targetChannel.send({
                        content: regionRoleInfo.mention || undefined,
                        embeds: embeds,
                        components: [raidButtonRow],
                        allowedMentions: regionRoleInfo.allowedMentions
                    });
                    raidStateManager.setRaidOpen(raid.raidId, guildId);
                    raidStateManager.updateRaidMessageReference(raid.raidId, targetChannel.id, message.id, guildId);
                } catch (err2) {
                    console.warn('Failed to post raid alert embed:', (err2 && err2.message) || err2);
                    raidStateManager.cleanupPendingRaids(userId, guildId);
                    await interaction.followUp({ content: '⚠️ The raid alert could not be posted to the configured raid channel. Please ask an admin to verify the channel configuration and try again.', flags: 64 }).catch(() => null);
                }
            }
        }
        // ===== RAID OPERATIONS: help / edit / accept / leave / close / outcome / mvp =====
        // [ Help ] — green public button: replies with an EPHEMERAL message that
        // contains the raid id and the server (Roblox deep) link.
        if (typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_help_')) {
            const raidId = Number(interaction.customId.split('_')[2]);
            if (Number.isNaN(raidId)) return;
            const raid = raidStateManager.getRaidById(raidId, interaction.guild?.id);
            if (!raid) {
                await interaction.reply({ content: 'Raid not found.', flags: 64 }).catch(() => null);
                return;
            }
            const serverLink = buildRobloxJoinLink(raid) || (raid.serverLink && /^https?:\/\//i.test(raid.serverLink) ? raid.serverLink : null);
            await interaction.reply({
                content: `📋 **Raid #${raid.raidId}** | ${serverLink ? '🔗 Server link: ' + serverLink : '🔗 Server link: not available (no place id recorded).'}`,
                flags: 64
            }).catch(() => null);
            return;
        }

        // [ Edit ] — grey staff/requester button: opens a modal to edit hostile
        // name / clan / count, then edits the existing alert message in place.
        if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_edit_')) {
            const raidId = Number(interaction.customId.split('_')[2]);
            if (Number.isNaN(raidId)) return;
            const raid = raidStateManager.getRaidById(raidId, interaction.guild?.id);
            if (!raid) {
                await interaction.reply({ content: 'Raid not found.', flags: 64 }).catch(() => null);
                return;
            }
            const editModal = new ModalBuilder()
                .setCustomId(`raid_editmodal_${raidId}`)
                .setTitle('Edit Raid Fields');
            const targetInput = new TextInputBuilder()
                .setCustomId('editTarget')
                .setLabel('Target')
                .setStyle(TextInputStyle.Short)
                .setValue(String(raid.robloxUsername || raid.requesterId || ''))
                .setRequired(false);
            const clanInput = new TextInputBuilder()
                .setCustomId('editEnemyClan')
                .setLabel('Enemy Clan')
                .setStyle(TextInputStyle.Short)
                .setValue(String(raid.enemyClanNames != null ? raid.enemyClanNames : ''))
                .setRequired(false);
            const countInput = new TextInputBuilder()
                .setCustomId('editEnemyCount')
                .setLabel('Enemy Count')
                .setStyle(TextInputStyle.Short)
                .setValue(String(raid.enemyCount || 0))
                .setRequired(false);
            const descInput = new TextInputBuilder()
                .setCustomId('editDescription')
                .setLabel('Description')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(String(raid.reason != null ? raid.reason : ''))
                .setRequired(false);
            editModal.addComponents(
                new ActionRowBuilder().addComponents(targetInput),
                new ActionRowBuilder().addComponents(clanInput),
                new ActionRowBuilder().addComponents(countInput),
                new ActionRowBuilder().addComponents(descInput)
            );
            await interaction.showModal(editModal).catch(() => null);
            return;
        }

        if (typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_accept_')) {
            const raidId = Number(interaction.customId.split('_')[2]);
            if (Number.isNaN(raidId)) {
                await interaction.reply({ content: 'Invalid raid ID.', flags: 64 }).catch(() => null);
                return;
            }
            const raid = raidStateManager.getRaidById(raidId, interaction.guild?.id);
            if (!raid) {
                await interaction.reply({ content: 'Raid not found.', flags: 64 }).catch(() => null);
                return;
            }
            if (raid.status === 'CLOSED') {
                await interaction.reply({ content: 'This raid is closed and cannot accept helpers.', flags: 64 }).catch(() => null);
                return;
            }
            const acceptModal = new ModalBuilder()
                .setCustomId(`raid_acceptmodal_${raidId}`)
                .setTitle('Join Raid Deployment Squad');
            const robloxInput = new TextInputBuilder()
                .setCustomId('helperRobloxUsername')
                .setLabel('Enter your active Roblox Username')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            acceptModal.addComponents(new ActionRowBuilder().addComponents(robloxInput));
            await interaction.showModal(acceptModal).catch(() => null);
            return;
        }

        if (typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_leave_')) {
            const raidId = Number(interaction.customId.split('_')[2]);
            if (Number.isNaN(raidId)) return;
            const result = raidStateManager.removeHelper(raidId, interaction.user.id, interaction.guild.id);
            if (!result.success) {
                await interaction.reply({ content: result.message, flags: 64 }).catch(() => null);
                return;
            }
            const updated = result.raid;
            const embeds = raidStateManager.formatRaidMessage(updated, interaction.guild.id);
            const row = createRaidButtons(updated, interaction.member);
            const channel = await interaction.client.channels.fetch(updated.channelId).catch(() => null);
            if (channel) {
                const message = await channel.messages.fetch(updated.messageId).catch(() => null);
                if (message) {
                    if (updated.alertFormat === 'v2') {
                        const updatedPayload = await raidV2.buildRaidAlertPayload(updated, row);
                        await message.edit({ components: updatedPayload.components }).catch(() => null);
                    } else {
                        await message.edit({ embeds: embeds, components: [row] }).catch(() => null);
                    }
                }
            }
            await interaction.reply({ content: 'You have left the raid.', flags: 64 }).catch(() => null);
            return;
        }

        if (typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_close_') || interaction.customId.startsWith('close_raid_')) {
            const raidId = Number(interaction.customId.split('_')[2]);
            if (Number.isNaN(raidId)) return;
            const raid = raidStateManager.getRaidById(raidId, interaction.guild?.id);
            if (!raid) {
                await interaction.reply({ content: 'Raid not found.', flags: 64 }).catch(() => null);
                return;
            }
            if (!canCloseRaid(interaction.member, raid)) {
                await interaction.reply({ content: 'Only the raid requester or an authorized staff member can close this raid.', flags: 64 }).catch(() => null);
                return;
            }
            const outcomeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`raid_outcome_win_${raidId}`).setLabel('🏆 Win').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`raid_outcome_whooped_${raidId}`).setLabel('🔥 Whooped').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`raid_outcome_loss_${raidId}`).setLabel('❌ Loss').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`raid_outcome_indeterminate_${raidId}`).setLabel('🤷 Can\'t Say').setStyle(ButtonStyle.Secondary)
            );
            await interaction.reply({
                content: '📊 **Select the final raid outcome to compile streaks and log metrics:**',
                components: [outcomeRow],
                flags: 64
            }).catch(() => null);
            return;
        }

        if (typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_outcome_')) {
            const parts = interaction.customId.split('_'); // raid_outcome_<outcome>_<raidId>
            const outcome = parts[2];
            const raidId = Number(parts[3]);
            if (Number.isNaN(raidId)) return;
            const raid = raidStateManager.getRaidById(raidId, interaction.guild?.id);
            if (!raid || raid.status === 'CLOSED') {
                await interaction.reply({ content: '❌ This raid record has already been locked.', flags: 64 }).catch(() => null);
                return;
            }
            raidStateManager.closeRaid(raidId, { outcome }, interaction.guild.id);
            let finalRaid = raidStateManager.getRaidById(raidId, interaction.guild.id) || raid;
            finalRaid.status = 'CLOSED';
            finalRaid.outcome = outcome;
            // Auto-calculate the MVP from the helper who spent the most active time.
            const autoHelpers = Array.isArray(finalRaid.helpers)
                ? finalRaid.helpers.filter(h => typeof h === 'object' && h.userId)
                : [];
            if (autoHelpers.length > 0) {
                let bestTime = -1;
                let mvpUserId = null;
                for (const h of autoHelpers) {
                    const t = Number(h.timeSpentSeconds) || 0;
                    if (t > bestTime) {
                        bestTime = t;
                        mvpUserId = h.userId;
                    }
                }
                // Fallback when no presence/join time was recorded.
                if (bestTime <= 0) mvpUserId = autoHelpers[0].userId;
                raidStateManager.setRaidMvp(raidId, mvpUserId, interaction.guild.id);
                finalRaid = raidStateManager.getRaidById(raidId, interaction.guild.id) || finalRaid;
            }
            await interaction.reply({ content: `✅ Combat operation logs compiled as **${outcome.toUpperCase()}**!`, flags: 64 }).catch(() => null);
            await finalizeRaidOutcome(interaction, finalRaid, outcome);
            return;
        }

        if (interaction.isStringSelectMenu() && typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_mvp_select_')) {
            const raidId = Number(interaction.customId.replace('raid_mvp_select_', ''));
            if (Number.isNaN(raidId)) return;
            const mvpUserId = interaction.values[0];
            const outcome = pendingRaidOutcomes.get(raidId);
            pendingRaidOutcomes.delete(raidId);
            let raid = raidStateManager.getRaidById(raidId, interaction.guild.id);
            if (!raid || raid.status !== 'CLOSED') {
                await interaction.reply({ content: '❌ This raid has already been finalized.', flags: 64 }).catch(() => null);
                return;
            }
            const actualOutcome = outcome || raid.outcome;
            if (!actualOutcome) {
                await interaction.reply({ content: '❌ Could not determine the raid outcome.', flags: 64 }).catch(() => null);
                return;
            }
            if (mvpUserId !== 'skip') {
                raidStateManager.setRaidMvp(raidId, mvpUserId, interaction.guild.id);
                raid = raidStateManager.getRaidById(raidId, interaction.guild.id);
            }
            await interaction.update({
                content: `🏆 MVP set to ${mvpUserId !== 'skip' ? '<@' + mvpUserId + '>' : 'none'}. Compiling raid result...`,
                components: [],
                flags: 64
            }).catch(() => null);
            await finalizeRaidOutcome(interaction, raid, actualOutcome);
            return;
        }

        if (interaction.isModalSubmit() && typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_editmodal_')) {
            const raidId = Number(interaction.customId.split('_')[2]); // raid_editmodal_<raidId>
            if (Number.isNaN(raidId)) return;
            const guildId = interaction.guild?.id;
            const raids = raidStateManager.loadRaids(guildId);
            const raid = raids.raids.find(item => item.raidId === raidId);
            if (!raid) {
                await interaction.reply({ content: 'Raid not found.', flags: 64 }).catch(() => null);
                return;
            }
            const enemyCount = safeGetTextInputValue(interaction.fields, 'editEnemyCount', raid.enemyCount);
            const newTarget = safeGetTextInputValue(interaction.fields, 'editTarget', raid.robloxUsername);
            const newClan = safeGetTextInputValue(interaction.fields, 'editEnemyClan', raid.enemyClanNames);
            const newDesc = safeGetTextInputValue(interaction.fields, 'editDescription', raid.reason);
            if (newTarget.trim() !== '') raid.robloxUsername = newTarget;
            raid.enemyClanNames = newClan.trim();
            raid.reason = newDesc.trim();
            raidStateManager.saveRaids(guildId, raids);

            // Re-render the EXISTING alert message IN PLACE (no new embed/message).
            if (raid.channelId && raid.messageId) {
                const channel = await interaction.client.channels.fetch(raid.channelId).catch(() => null);
                if (channel) {
                    const message = await channel.messages.fetch(raid.messageId).catch(() => null);
                    if (message) {
                        const row = createRaidButtons(raid, interaction.member);
                        if (raid.alertFormat === 'v2') {
                            const payload = await raidV2.buildRaidAlertPayload(raid, row);
                            await message.edit({ components: payload.components }).catch(() => null);
                        } else {
                            const embeds = raidStateManager.formatRaidMessage(raid, guildId);
                            await message.edit({ embeds: embeds, components: [row] }).catch(() => null);
                        }
                    }
                }
            }
            await interaction.reply({ content: '✅ Raid fields updated in the alert.', flags: 64 }).catch(() => null);
            return;
        }

        if (interaction.isModalSubmit() && typeof interaction.customId === 'string' && interaction.customId.startsWith('raid_acceptmodal_')) {
            const raidId = Number(interaction.customId.split('_')[2]);
            const helperUsername = interaction.fields.getTextInputValue('helperRobloxUsername');
            const guildId = interaction.guild.id;
            const currentRaid = raidStateManager.getRaidById(raidId, guildId);
            if (!currentRaid || currentRaid.status === 'CLOSED') {
                await interaction.reply({ content: 'This raid operation is no longer active or closed.', flags: 64 }).catch(() => null);
                return;
            }
            const robloxValidation = await robloxApi.validateAndGetAvatar(helperUsername);
            if (!robloxValidation.success) {
                await interaction.reply({ content: `❌ **Roblox Username Validation Failed**\n${robloxValidation.error}`, flags: 64 }).catch(() => null);
                return;
            }
            await verificationDb.directLink(interaction.user.id, {
                robloxUsername: helperUsername,
                robloxDisplayName: robloxValidation.displayName || helperUsername,
                robloxUserId: robloxValidation.userId || "1",
                robloxAvatarUrl: robloxValidation.avatarUrl || null
            }, guildId);
            const result = await raidStateManager.addHelper(raidId, interaction.user.id, {
                username: helperUsername,
                displayName: robloxValidation.displayName || helperUsername,
                userId: robloxValidation.userId || "1",
                avatarUrl: robloxValidation.avatarUrl || null
            }, guildId);
            if (!result.success) {
                await interaction.reply({ content: result.message, flags: 64 }).catch(() => null);
                return;
            }
            const updated = result.raid;
            const embeds = raidStateManager.formatRaidMessage(updated, interaction.guild.id);
            const row = createRaidButtons(updated, interaction.member);
            const channel = await interaction.client.channels.fetch(updated.channelId).catch(() => null);
            if (channel) {
                const message = await channel.messages.fetch(updated.messageId).catch(() => null);
                if (message) {
                    if (updated.alertFormat === 'v2') {
                        const updatedPayload = await raidV2.buildRaidAlertPayload(updated, row);
                        await message.edit({ components: updatedPayload.components }).catch(() => null);
                    } else {
                        await message.edit({ embeds: embeds, components: [row] }).catch(() => null);
                    }
                }
            }
            // Send the helper their deployment info.
            const gameLabel = raidStateManager.GAME_CONFIG[updated.targetGame] || updated.targetGame || 'Unknown';
            const helperEmbed = new EmbedBuilder()
                .setTitle(`Raid #${updated.raidId} — Join Deployment`)
                .setDescription('You have been accepted as a helper for this raid.')
                .addFields([
                    { name: 'Game', value: gameLabel, inline: true },
                    { name: 'Region', value: updated.region || 'Unknown', inline: true },
                    { name: 'Raid ID', value: `#${updated.raidId}`, inline: true },
                    { name: 'Server Link', value: updated.serverLink ? `[Join Server](${updated.serverLink})` : 'No link provided', inline: false }
                ])
                .setColor(0xFFD700)
                .setFooter({ text: 'Kakuzu Raid System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                .setTimestamp();
            const deepLink = buildRobloxJoinLink(updated);
            const joinRow = deepLink
                ? new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Server').setURL(deepLink)
                )
                : null;
            await interaction.reply({
                content: `✅ Raid Request Accepted!`,
                embeds: [helperEmbed],
                components: joinRow ? [joinRow] : [],
                flags: 64
            }).catch(() => null);
            return;
        }
    }
    }
;

