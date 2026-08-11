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
const robloxApi = require("../handlers/robloxApi");
const verificationDb = require("../handlers/verificationDb");
const { formatRobloxProfileValue } = require("../handlers/verificationHelpers");
const pendingRaidApplications = new Map();
const pendingRegionSelections = new Map();
const pendingGameSelections = new Map();
const pendingRaidOutcomes = new Map();

// Region ping IDs are now configured per-guild via settings.regionPings

// Whitelisted roles updated with Supreme Leader included
const RAID_CLOSE_ROLES = [
    'Administrator',
    'Management Supervisor',
    'Community Manager',
    'Senior Moderator',
    '?? ? SUPREME LEADER'
];

// Roles that can accept/deny verifications are NO LONGER hardcoded by name.
// They are configured per-guild via /verificationadminrole and stored as role
// IDs in the persistent per-guild settings.json so they survive restarts and
// are never affected by role name changes.

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

function createRaidButtons(raid, member = null) {
    const accept = new ButtonBuilder()
        .setCustomId(`raid_accept_${raid.raidId}`)
        .setLabel("Accept Raid")
        .setStyle(ButtonStyle.Success)
        .setDisabled(raid.status !== "OPEN");

    const components = [accept];
    const showClose = canCloseRaid(member, raid);
    if (showClose) {
        const close = new ButtonBuilder()
            .setCustomId(`raid_close_${raid.raidId}`)
            .setLabel("Close Raid")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(raid.status === "CLOSED");
        components.push(close);
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
    if (value === null || value === undefined) return '—';
    const stringValue = String(value).trim();
    return stringValue || '—';
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
        description: '> ?? **CONGRATULATIONS!** ??\nYour verification request has been **approved**.\nWelcome to the clan — we\'re thrilled to have you aboard! ??',
        color: 0x2ECC71,
        footerText: `?? Kakuzu Verification System • ? Approved at ${reviewedAt}`,
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
        description: '> ?? Unfortunately, your verification request was **rejected** by the verification staff.\nPlease review the reason below — you are welcome to try again later. ??',
        color: 0xE74C3C,
        footerText: `?? Kakuzu Verification System • ? Rejected at ${reviewedAt}`,
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
                const prefix = isMvp ? '?? MVP: ' : '• ';
                return `${prefix}<@${helperUserId}> (Roblox: ${helperRobloxUsername}) — Time Spent: ${timeSpent}`;
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
                const regionRoleInfo = getRegionRoleInfo(interaction.guild.id, raid.region);
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
                const updatedAlertEmbed = raidStateManager.formatRaidMessage(raid);
                const cleanClosedRow = createRaidButtons(raid, interaction.member);
                await baseAlertMsg.edit({ embeds: [updatedAlertEmbed], components: [cleanClosedRow] }).catch(() => null);
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
                console.error('Command execution error:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'An error occurred while executing that command.', flags: 64 }).catch(() => null);
                } else {
                    await interaction.followUp({ content: 'An error occurred while executing that command.', flags: 64 }).catch(() => null);
                }
            }
            return;
        }

        // Handle request_raid button - auto-detect game/region/server
        if (interaction.customId === "request_raid") {
            const verificationDb = require("../handlers/verificationDb");
            const isVerified = await verificationDb.isUserVerified(interaction.user.id, interaction.guild.id);
            if (!isVerified) {
                return interaction.reply({
                    content: "Raid Access Denied - Verification Required. Run /link-roblox first.",
                    flags: 64
                }).catch(() => null);
            }

            const verificationData = await verificationDb.getVerificationData(interaction.user.id, interaction.guild.id);
            if (!verificationData || !verificationData.roblox_user_id) {
                return interaction.reply({
                    content: "Please run /link-roblox first.",
                    flags: 64
                }).catch(() => null);
            }

            const robloxUserId = verificationData.roblox_user_id;
            const detection = await robloxApi.detectGameAndRegion(robloxUserId);

            if (!detection.success) {
                return interaction.reply({
                    content: "Auto-Detection Failed: " + detection.error + ". Make sure you are in a Roblox game.",
                    flags: 64
                }).catch(() => null);
            }

            pendingGameSelections.set(interaction.user.id, detection.game);
            pendingRegionSelections.set(interaction.user.id, detection.region);

            const modal = new ModalBuilder()
                .setCustomId("raid_application_step1")
                .setTitle("Raid Request Application");

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("enemyCount")
                        .setLabel("Number of Enemies")
                        .setPlaceholder("e.g., 5")
                        .setStyle(TextInputStyle.Short)
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
                        .setLabel("Enemy Clan Name (Optional)")
                        .setPlaceholder("Leave blank for not provided")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                )
            );

            return interaction.showModal(modal).catch(() => null);
        }

        if (interaction.customId === "raid_application_step1") {
                const userId = interaction.user.id;
                if (!raidStateManager.canCreateRaid(userId, interaction.guild.id)) {
                    return interaction.reply({ content: "You already have an open raid or you are blocked from creating new raids.", flags: 64 }).catch(() => null);
                }

                const game = pendingGameSelections.get(userId);
                const region = pendingRegionSelections.get(userId);
                
                if (!game || !region) {
                    pendingGameSelections.delete(userId);
                    pendingRegionSelections.delete(userId);
                    return interaction.reply({ content: "Game detection expired. Please try again.", flags: 64 }).catch(() => null);
                }

                const partial = {
                    requesterId: userId,
                    requesterTag: interaction.user.tag,
                    targetGame: game,
                    region: region,
                    enemyCount: interaction.fields.getTextInputValue("enemyCount"),
                    helperLimit: interaction.fields.getTextInputValue("helperLimit"),
                    enemyClanName: interaction.fields.getTextInputValue("enemyClanName") || "not provided"
                };

                // Clear game/region selections
                pendingGameSelections.delete(userId);
                pendingRegionSelections.delete(userId);
                pendingRaidApplications.set(userId, partial);

                const continueButton = new ButtonBuilder()
                    .setCustomId("raid_step2_continue")
                    .setLabel("Continue to Step 2")
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(continueButton);
                return interaction.reply({
                    content: "Step 1 saved! Click the button below to continue.",
                    components: [row],
                    flags: 64
                }).catch(() => null);
            }

            // Handle raid_step2_continue button - show step2 modal
            if (interaction.customId === "raid_step2_continue") {
                const userId = interaction.user.id;
                const partial = pendingRaidApplications.get(userId);
                
                if (!partial) {
                    return interaction.reply({ content: "Raid application expired. Please start over.", flags: 64 }).catch(() => null);
                }

                const modal = new ModalBuilder()
                    .setCustomId("raid_application_step2")
                    .setTitle("Raid Application - Step 2");

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("teamers")
                            .setLabel("Number of Teamers")
                            .setPlaceholder("e.g., 2")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("enemyClanPresent")
                            .setLabel("Is Enemy Clan Present? (yes/no)")
                            .setPlaceholder("yes or no")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("reason")
                            .setLabel("Reason for Raid Request")
                            .setPlaceholder("Explain why you need help")
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(true)
                    )
                );

                return interaction.showModal(modal).catch(() => null);
            }

            if (interaction.customId === "raid_application_step2") {
                const userId = interaction.user.id;
                const partial = pendingRaidApplications.get(userId);
                pendingRaidApplications.delete(userId);
                if (!partial) {
                    return interaction.reply({ content: "Raid application expired. Please start over.", flags: 64 }).catch(() => null);
                }

                const enemyCount = Number(partial.enemyCount);
                const helperLimit = Number(partial.helperLimit);
                const enemyClanName = partial.enemyClanName || "not provided";
                const teamers = interaction.fields.getTextInputValue("teamers");
                const enemyClanPresent = interaction.fields.getTextInputValue("enemyClanPresent");
                const reason = interaction.fields.getTextInputValue("reason");

                if (Number.isNaN(enemyCount) || enemyCount <= 2) {
                    return interaction.reply({ content: "Enemy count must be a number greater than 2.", flags: 64 }).catch(() => null);
                }
                if (Number.isNaN(helperLimit) || helperLimit < 1 || helperLimit > 20) {
                    return interaction.reply({ content: "Helpers needed must be a number between 1 and 20.", flags: 64 }).catch(() => null);
                }

                // Get Roblox data from verification
                const verificationData = await verificationDb.getVerificationData(userId, interaction.guild.id);
                const robloxUsername = verificationData?.roblox_username || 'Unknown';
                const robloxDisplayName = verificationData?.roblox_display_name || robloxUsername;
                const robloxUserId = verificationData?.roblox_user_id || "1";
                const robloxAvatarUrl = verificationData?.roblox_avatar_url || null;

                const raid = raidStateManager.createRaid({
                    requesterId: userId,
                    requesterTag: interaction.user.tag,
                    targetGame: partial.targetGame,
                    robloxUsername,
                    robloxDisplayName,
                    robloxUserId,
                    robloxAvatarUrl,
                    serverLink: partial.serverLink || '',
                    region: partial.region,
                    enemyCount,
                    teamers,
                    enemyClanName,
                    enemyClanPresent,
                    reason,
                    helperLimit,
                    guildId: interaction.guild.id
                });

                const settings = raidStateManager.loadSettings(interaction.guild.id);
                const content = raidStateManager.formatRaidMessage(raid);
                const raidButtonRow = createRaidButtons(raid, interaction.member);
                const regionRoleInfo = getRegionRoleInfo(interaction.guild.id, raid.region);

                // Require an explicitly configured raid channel. Do NOT fallback to the command channel.
                if (!settings.raidChannel) {
                    return interaction.reply({ content: '? Raid channel is not configured. Please run `/setchannels` and set the `raid_channel` first (Raid Alert channel).', flags: 64 }).catch(() => null);
                }

                const targetChannel = await interaction.client.channels.fetch(settings.raidChannel).catch(() => null);

                if (!targetChannel || !targetChannel.isTextBased()) {
                    return interaction.reply({ content: '? Configured raid channel is unavailable or not a text channel. Please reconfigure it with `/setchannels`.', flags: 64 }).catch(() => null);
                }

                const completionEmbed = new EmbedBuilder()
                    .setTitle('?? Raid Request Successfully Launched!')
                    .setDescription(`Operator <@${userId}> has successfully deployed a combat request!`)
                    .addFields([
                        { name: 'Raid Registry ID', value: `\`#${raid.raidId}\``, inline: true },
                        { name: 'Roblox Identity', value: `\`${robloxUsername}\``, inline: true },
                        { name: 'Target Game', value: `\`${raidStateManager.GAME_CONFIG[partial.targetGame] || partial.targetGame}\``, inline: true },
                        { name: 'Target Region', value: `\`${region}\``, inline: true }
                    ])
                    .setColor(0x00ff66)
                    .setTimestamp();

                await interaction.reply({ embeds: [completionEmbed], flags: 64 }).catch(() => null);

                const message = await targetChannel.send({
                    content: regionRoleInfo.mention || undefined,
                    embeds: [content],
                    components: [raidButtonRow],
                    allowedMentions: regionRoleInfo.allowedMentions
                });
                raidStateManager.updateRaidMessageReference(raid.raidId, targetChannel.id, message.id, interaction.guild.id);
            }
        }
    }
;

