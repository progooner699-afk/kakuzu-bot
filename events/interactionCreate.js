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

// Region ping IDs are now configured per-guild via settings.regionPings

// Whitelisted roles updated with Supreme Leader included
const RAID_CLOSE_ROLES = [
    'Administrator',
    'Management Supervisor',
    'Community Manager',
    'Senior Moderator',
    '💣 ‖ SUPREME LEADER'
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

    const leave = new ButtonBuilder()
        .setCustomId(`raid_leave_${raid.raidId}`)
        .setLabel("Leave Raid")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(raid.status === "CLOSED");

    const components = [accept, leave];
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
        .setLabel("✅ Accept Verification")
        .setStyle(ButtonStyle.Success);

    const denyBtn = new ButtonBuilder()
        .setCustomId(`verify_deny_${userId}`)
        .setLabel("❌ Deny Verification")
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
        title: '🎉✅ PLAYER VERIFIED ✅🎉',
        description: '> 🎊 **CONGRATULATIONS!** 🎊\nYour verification request has been **approved**.\nWelcome to the clan — we\'re thrilled to have you aboard! 🥳',
        color: 0x2ECC71,
        footerText: `🔐 Kakuzu Verification System • ✅ Approved at ${reviewedAt}`,
        thumbnailUrl: values.robloxAvatarUrl || guild.iconURL({ size: 256 }),
        imageUrl: null,
        fields: [
            { name: '👤 Player', value: values.targetUserTag, inline: false },
            { name: '🎮 Roblox Profile', value: getVerificationFieldValue(values.robloxProfileValue), inline: true },
            { name: '⚔️ Kill Count', value: getVerificationFieldValue(values.killCount), inline: true },
            { name: '🔗 PS Link', value: getVerificationFieldValue(values.psLink), inline: true },
            { name: '🖼️ Friend List', value: getVerificationFieldValue(values.friendList), inline: false },
            { name: '📋 Status', value: '✅ **ACCEPTED**', inline: true },
            { name: '🧑‍⚖️ Verified By', value: reviewerTag, inline: true },
            { name: '🏷️ Verification ID', value: getVerificationFieldValue(values.verificationId), inline: true },
            { name: '🕒 Verified At', value: reviewedAt, inline: false }
        ]
    });
}

function buildRejectedEmbed({ values, reviewerTag, reviewedAt, guild, reason }) {
    return buildVerificationEmbed({
        title: '❌ PLAYER VERIFICATION REJECTED',
        description: '> 😔 Unfortunately, your verification request was **rejected** by the verification staff.\nPlease review the reason below — you are welcome to try again later. 💪',
        color: 0xE74C3C,
        footerText: `🔐 Kakuzu Verification System • ❌ Rejected at ${reviewedAt}`,
        thumbnailUrl: values.robloxAvatarUrl || guild.iconURL({ size: 256 }),
        imageUrl: null,
        fields: [
            { name: '👤 Player', value: values.targetUserTag, inline: false },
            { name: '🎮 Roblox Profile', value: getVerificationFieldValue(values.robloxProfileValue), inline: true },
            { name: '⚔️ Kill Count', value: getVerificationFieldValue(values.killCount), inline: true },
            { name: '🔗 PS Link', value: getVerificationFieldValue(values.psLink), inline: true },
            { name: '🖼️ Friend List', value: getVerificationFieldValue(values.friendList), inline: false },
            { name: '📝 Reason', value: getVerificationFieldValue(reason), inline: false },
            { name: '📋 Status', value: '❌ **REJECTED**', inline: true },
            { name: '🧑‍⚖️ Rejected By', value: reviewerTag, inline: true },
            { name: '🏷️ Verification ID', value: getVerificationFieldValue(values.verificationId), inline: true },
            { name: '🕒 Rejected At', value: reviewedAt, inline: false }
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

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "raid_region_select") {
                const region = interaction.values[0];
                pendingRegionSelections.set(interaction.user.id, region);

                const modal = new ModalBuilder()
                    .setCustomId("raid_application_step1")
                    .setTitle("Raid Request Application – Step 1");

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("robloxUsername")
                            .setLabel("Roblox Username")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("serverLink")
                            .setLabel("Server Link")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("enemyCount")
                            .setLabel("Enemy Count")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("helperLimit")
                            .setLabel("Helpers Needed (1-20)")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    )
                );

                return interaction.showModal(modal);
            }
        }

        if (interaction.isButton()) {
            const customId = interaction.customId;

            // ===== VERIFICATION: Accept button =====
            if (customId.startsWith("verify_accept_")) {
                if (!canModerateVerification(interaction.member)) {
                    return interaction.reply({
                        content: "❌ You do not have permission to accept verifications.",
                        flags: 64
                    });
                }

                const targetUserId = customId.replace("verify_accept_", "");
                const guild = interaction.guild;

                const guildId = interaction.guild.id;

                // Prevent double processing (DB-level guard ensures only a
                // PENDING request can be accepted).
                const result = await verificationDb.acceptVerification(targetUserId, interaction.user.id, guildId);
                if (!result.success) {
                    return interaction.reply({
                        content: `❌ ${result.message}`,
                        flags: 64
                    });
                }

                // Remove locked ping role from the user
                const settings = raidStateManager.loadSettings(guildId);
                if (settings.lockedPingRoleId) {
                    try {
                        const member = await guild.members.fetch(targetUserId).catch(() => null);
                        if (member) {
                            const lockedRole = guild.roles.cache.get(settings.lockedPingRoleId);
                            if (lockedRole && member.roles.cache.has(lockedRole.id)) {
                                await member.roles.remove(lockedRole);
                            }
                        }
                    } catch (error) {
                        console.warn(`Could not remove locked ping role from ${targetUserId}: ${error.message}`);
                    }
                }

                // Update the verification log embed (this button lives on the log message
                // in the verification logs channel). Buttons are removed/disabled.
                const verificationData = await verificationDb.getVerificationData(targetUserId, guildId);
                const reviewedAt = formatVerificationDate(verificationData?.reviewed_at || Date.now());
                const values = getVerificationValues(verificationData, `<@${targetUserId}>`);

                const logEmbed = buildVerificationEmbed({
                    title: '✅ VERIFICATION ACCEPTED',
                    description: 'A moderator approved this verification request.',
                    color: 0x2ECC71,
                    footerText: `Accepted by ${interaction.user.tag} • ${reviewedAt}`,
                    thumbnailUrl: verificationData?.roblox_avatar_url || guild.iconURL({ size: 256 }),
                    fields: [
                        { name: '👤 Applicant', value: values.targetUserTag, inline: true },
                        { name: '🛡️ Status', value: '✅ ACCEPTED', inline: true },
                        { name: '🧾 Verified By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: '🆔 Verification ID', value: getVerificationFieldValue(values.verificationId), inline: true }
                    ]
                });

                await interaction.update({
                    embeds: [logEmbed],
                    components: [] // Remove/disable Accept & Reject buttons
                }).catch(() => editStoredVerificationMessage(interaction.client, verificationData, logEmbed, []));

                // Send final result to the verification result channel (mention the user above the embed)
                const finalEmbed = buildAcceptedEmbed({ values, reviewerTag: `<@${interaction.user.id}>`, reviewedAt, guild });
                await sendVerificationResult(interaction.client, guildId, targetUserId, finalEmbed).catch(() => null);

                // DM the user with the full accepted embed (never crash if DMs are disabled)
                const dmEmbed = buildVerificationEmbed({
                    title: '✅ Verification Accepted',
                    description: 'Your player verification has been approved.',
                    color: 0x2ECC71,
                    footerText: `Kakuzu Verification System • ${reviewedAt}`,
                    thumbnailUrl: interaction.client.user.displayAvatarURL({ size: 256 }),
                    fields: [
                        { name: '**Roblox Username**', value: getVerificationFieldValue(values.robloxUsername), inline: true },
                        { name: '**Kill Count**', value: getVerificationFieldValue(values.killCount), inline: true },
                        { name: '**PS Link**', value: getVerificationFieldValue(values.psLink), inline: true },
                        { name: '**Verification ID**', value: getVerificationFieldValue(values.verificationId), inline: true },
                        { name: '**Approved By**', value: `<@${interaction.user.id}>`, inline: true },
                        { name: '**Date/Time**', value: reviewedAt, inline: true },
                        { name: '**Status**', value: '✅ ACCEPTED', inline: false }
                    ]
                });
                const dmResult = await sendVerificationDM(interaction.client, targetUserId, dmEmbed);
                if (!dmResult.delivered) {
                    console.warn(`DM acceptance to ${targetUserId} could not be delivered (${dmResult.reason}). Result was still posted to the result channel.`);
                }

                return;
            }

            // ===== VERIFICATION: Deny button =====
            if (customId.startsWith("verify_deny_")) {
                if (!canModerateVerification(interaction.member)) {
                    return interaction.reply({
                        content: "❌ You do not have permission to deny verifications.",
                        flags: 64
                    });
                }

                const targetUserId = customId.replace("verify_deny_", "");

                // Show a modal asking for the rejection reason
                const denyModal = new ModalBuilder()
                    .setCustomId(`verify_deny_reason_${targetUserId}`)
                    .setTitle("Reject Verification - Provide Reason");

                const reasonInput = new TextInputBuilder()
                    .setCustomId("deny_reason")
                    .setLabel("Reason for Rejection")
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder("Explain why this verification is being rejected...")
                    .setRequired(true)
                    .setMaxLength(1000);

                denyModal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

                return interaction.showModal(denyModal);
            }

            // Verification: Submit Info button
            if (customId === "verify_submit_info") {
                const modal = new ModalBuilder()
                    .setCustomId("verify_modal_submit")
                    .setTitle("TSB Info Collector - Verification Form");

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("verify_roblox_username")
                            .setLabel("Roblox Username")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("verify_roblox_ps_link")
                            .setLabel("Roblox Private Server (PS) Link")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("verify_kill_count")
                            .setLabel("Kill Counts")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("verify_friend_list_link")
                            .setLabel("Friend List Screenshot URL (Optional)")
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder("Paste a screenshot URL here (optional)")
                            .setRequired(false)
                    )
                );

                return interaction.showModal(modal);
            }

            if (customId === "request_raid") {
                const regionSelect = new StringSelectMenuBuilder()
                    .setCustomId("raid_region_select")
                    .setPlaceholder("Select a region")
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(
                        new StringSelectMenuOptionBuilder().setLabel("NA").setValue("NA"),
                        new StringSelectMenuOptionBuilder().setLabel("SA").setValue("SA"),
                        new StringSelectMenuOptionBuilder().setLabel("ASIA").setValue("ASIA"),
                        new StringSelectMenuOptionBuilder().setLabel("EU").setValue("EU"),
                        new StringSelectMenuOptionBuilder().setLabel("AUST").setValue("AUST")
                    );

                return interaction.reply({
                    content: "Select the raid region from the dropdown below.",
                    components: [new ActionRowBuilder().addComponents(regionSelect)],
                    flags: 64
                }).catch(() => null);
            }

            if (customId === "raid_step2_continue") {
                const modal = new ModalBuilder()
                    .setCustomId("raid_application_step2")
                    .setTitle("Raid Request Application – Step 2");

                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("teamers")
                            .setLabel("Teamers")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("enemyClanNames")
                            .setLabel("Enemy Clan Names")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("enemyClanPresent")
                            .setLabel("Enemy Clan Present (YES/NO)")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("reason")
                            .setLabel("Reason for Raid")
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(true)
                    )
                );

                return interaction.showModal(modal);
            }

            const parts = customId.split("_");
            const prefix = parts[0];
            const action = parts[1];
            
            let raidId;
            let outcome = null;

            if (action === "outcome") {
                outcome = parts[2];
                raidId = Number(parts[3]);
            } else {
                raidId = Number(parts[2]);
            }

            if (prefix !== "raid" || Number.isNaN(raidId)) return;

            const raid = raidStateManager.getRaidById(raidId, interaction.guild.id);
            if (!raid) {
                return interaction.reply({ content: "Raid not found.", flags: 64 }).catch(() => null);
            }

            if (action === "accept") {
                if (raid.status === "CLOSED") {
                    return interaction.reply({ content: "This raid is closed and cannot accept helpers.", flags: 64 }).catch(() => null);
                }

                const acceptModal = new ModalBuilder()
                    .setCustomId(`raid_acceptmodal_${raidId}`)
                    .setTitle("Join Raid Deployment Squad");

                const robloxInput = new TextInputBuilder()
                    .setCustomId("helperRobloxUsername")
                    .setLabel("Enter your active Roblox Username")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                acceptModal.addComponents(new ActionRowBuilder().addComponents(robloxInput));
                return interaction.showModal(acceptModal).catch(() => null);
            }

            if (action === "leave") {
                const result = raidStateManager.removeHelper(raidId, interaction.user.id, interaction.guild.id);
                if (!result.success) {
                    return interaction.reply({ content: result.message, flags: 64 });
                }
                const updated = result.raid;
                const content = raidStateManager.formatRaidMessage(updated);
                const row = createRaidButtons(updated, interaction.member);
                const channel = await interaction.client.channels.fetch(updated.channelId).catch(() => null);
                if (channel) {
                    const message = await channel.messages.fetch(updated.messageId).catch(() => null);
                    if (message) await message.edit({ embeds: [content], components: [row] });
                }

                return interaction.reply({ content: "You have left the raid.", flags: 64 }).catch(() => null);
            }

            if (action === "close") {
                const member = interaction.member;
                if (!canCloseRaid(member, raid)) {
                    return interaction.reply({ content: "Only the raid requester or an authorized staff member can close this raid.", flags: 64 }).catch(() => null);
                }

                const outcomeRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`raid_outcome_win_${raidId}`).setLabel('🟢 Win').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`raid_outcome_whooped_${raidId}`).setLabel('🔥 Whooped').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`raid_outcome_loss_${raidId}`).setLabel('🔴 Loss').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`raid_outcome_cantsay_${raidId}`).setLabel('🤷 Can\'t Say').setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    content: '📊 **Select the final raid outcome to compile streaks and log metrics:**',
                    components: [outcomeRow],
                    flags: 64
                }).catch(() => null);
            }

            if (action === "outcome") {
                const activeRaid = raidStateManager.getRaidById(raidId, interaction.guild.id);
                if (!activeRaid || activeRaid.status === 'CLOSED') {
                    return interaction.reply({ content: '❌ This raid record has already been locked.', flags: 64 }).catch(() => null);
                }

                    raidStateManager.closeRaid(raidId, undefined, interaction.guild.id);
                    activeRaid.status = 'CLOSED';

                    const settings = raidStateManager.loadSettings(interaction.guild.id);
                    const raidsData = raidStateManager.loadRaids(interaction.guild.id);
                let descriptionText = '';

                if (outcome === 'win' || outcome === 'whooped') {
                    if (raidsData.streakType === 'WIN') {
                        raidsData.streakCount += 1;
                    } else {
                        raidsData.streakType = 'WIN';
                        raidsData.streakCount = 1;
                    }

                    if (outcome === 'whooped') {
                        resultTitle = '🔥 OBLITERATION DEPLOYMENT (WHOOPED) 🔥';
                        resultColor = 0xff0055;
                        descriptionText = `Our combat deployment completely **WHOOPED** the opposition forces! A flawless victory.`;
                    } else {
                        resultTitle = '🏆 OPERATION VICTORY 🏆';
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
                    resultTitle = '❌ DEPLOYMENT LOSS ❌';
                    resultColor = 0xff3333;
                    descriptionText = `Our combat crew suffered an operational defeat against enemy forces during deployment.`;
                } else {
                    resultTitle = '⚖️ INDECISIVE CONCLUSION / CAN\'T SAY ⚖️';
                    resultColor = 0x888888;
                    descriptionText = `The combat operation concluded indeterminately, or was cancelled mid-deployment.`;
                }

                raidStateManager.saveRaids(interaction.guild.id, raidsData);

                const streakMessage = raidsData.streakCount > 0 
                    ? `**Current Streak:** ${raidsData.streakType === 'WIN' ? '🔥' : '💀'} ${raidsData.streakCount} Matches consecutive!`
                    : '**Current Streak:** None tracking';

                const buildReportCardEmbed = (attachments = []) => {
                    const embed = new EmbedBuilder()
                        .setTitle(resultTitle)
                        .setDescription(`${descriptionText}\n\n${streakMessage}`)
                        .setColor(resultColor)
                        .addFields([
                            { name: 'Operation Registry', value: `\`#${activeRaid.raidId}\``, inline: true },
                            { name: 'Squad Leader', value: `<@${activeRaid.requesterId}>`, inline: true },
                            { name: 'Region Server', value: `\`${activeRaid.region || 'Unknown'}\``, inline: true },
                            { name: 'Hostile Count', value: `\`${activeRaid.enemyCount || 0}\``, inline: true },
                            { name: 'Hostile Grouping', value: activeRaid.enemyClanNames ? `\`${activeRaid.enemyClanNames}\`` : '`None`', inline: true },
                            { name: 'Deployment Squad Roster', value: activeRaid.helpers.length > 0 ? activeRaid.helpers.map(h => typeof h === 'string' ? `<@${h}>` : `<@${h.userId}>`).join(', ') : 'No operators deployed.', inline: false }
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
                            const regionRoleInfo = getRegionRoleInfo(interaction.guild.id, activeRaid.region);
                            await targetResultChannel.send({
                                content: regionRoleInfo.mention || undefined,
                                embeds: [buildReportCardEmbed(attachments)],
                                allowedMentions: regionRoleInfo.allowedMentions
                            });
                        }
                    }
                };

                const alertChannel = await interaction.client.channels.fetch(activeRaid.channelId).catch(() => null);
                if (alertChannel) {
                    const baseAlertMsg = await alertChannel.messages.fetch(activeRaid.messageId).catch(() => null);
                    if (baseAlertMsg) {
                        const updatedAlertEmbed = raidStateManager.formatRaidMessage(activeRaid);
                        const cleanClosedRow = createRaidButtons(activeRaid, interaction.member);
                        await baseAlertMsg.edit({ embeds: [updatedAlertEmbed], components: [cleanClosedRow] }).catch(() => null);
                    }
                }

                await interaction.update({ content: `✅ Combat operation logs compiled as **${outcome.toUpperCase()}**!`, components: [] });

                // Try to create a temporary upload channel for 60 seconds where participants
                // can upload pictures. If channel creation fails, fall back to the old in-channel collector.
                let uploadedUrls = [];
                const guild = interaction.guild;
                let tempChannel = null;

                try {
                    const parentId = interaction.channel?.parentId || null;
                    tempChannel = await guild.channels.create({
                        name: `raid-uploads-${activeRaid.raidId}`,
                        type: ChannelType.GuildText,
                        parent: parentId || undefined,
                        topic: `Temporary upload channel for raid #${activeRaid.raidId}. Will be removed after collection.`
                    });

                    // Notify users where to upload (ephemeral instruction plus a message in the temp channel)
                    await interaction.followUp({ content: `📸 Upload any pictures or files for this raid result in ${tempChannel} now. Reply with \`done\` in that channel when finished, or wait 60 seconds. The result will be posted to the configured result channel automatically.`, ephemeral: true }).catch(() => null);

                    await tempChannel.send({ content: `📸 **Upload pictures for Raid #${activeRaid.raidId} here.**
Reply with \`done\` (by <@${interaction.user.id}>) when finished, or wait 60 seconds and the bot will post whatever was uploaded.` }).catch(() => null);

                    const collector = tempChannel.createMessageCollector({
                        filter: (msg) => {
                            // Accept attachments from anyone; accept the `done` command from the user who closed the raid
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

                        // Attempt to delete the temporary channel after a short delay
                        setTimeout(async () => {
                            try {
                                if (tempChannel && !tempChannel.deleted) await tempChannel.delete('Temporary raid upload channel expired');
                            } catch (err) {
                                // ignore deletion errors
                            }
                        }, 2000);
                    });

                    return;
                } catch (error) {
                    console.warn('Could not create temporary upload channel, falling back to in-channel collector:', error?.message || error);
                    // Fallthrough to the legacy behavior below
                }

                // Legacy fallback: collect in the interaction channel (30s) from the raid-closer only
                await interaction.followUp({ content: '📸 Upload any pictures or files for this raid result in this channel. Reply with `done` when finished, or just wait 30 seconds. The result will be sent automatically after.', ephemeral: true }).catch(() => null);

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

                return;
            }
        }

        if (interaction.isModalSubmit()) {
            // ===== VERIFICATION: Deny reason modal =====
            if (interaction.customId.startsWith("verify_deny_reason_")) {
                const targetUserId = interaction.customId.replace("verify_deny_reason_", "");
                const reason = interaction.fields.getTextInputValue("deny_reason");
                const guild = interaction.guild;
                const guildId = interaction.guild.id;

                // Prevent double processing (DB-level guard ensures only a
                // PENDING request can be rejected).
                const result = await verificationDb.rejectVerification(targetUserId, interaction.user.id, reason, guildId);
                if (!result.success) {
                    return interaction.reply({
                        content: `❌ ${result.message}`,
                        flags: 64
                    });
                }

                const verificationData = await verificationDb.getVerificationData(targetUserId, guildId);
                const reviewedAt = formatVerificationDate(verificationData?.reviewed_at || Date.now());
                const values = getVerificationValues(verificationData, `<@${targetUserId}>`);

                await interaction.reply({
                    content: `✅ Verification for <@${targetUserId}> has been **rejected**.`,
                    flags: 64
                });

                // Update the verification log embed in the logs channel (no buttons)
                const updatedEmbed = buildVerificationEmbed({
                    title: '❌ VERIFICATION REJECTED',
                    description: 'A moderator rejected this verification request.',
                    color: 0xE74C3C,
                    footerText: `Rejected by ${interaction.user.tag} • ${reviewedAt}`,
                    thumbnailUrl: verificationData?.roblox_avatar_url || guild.iconURL({ size: 256 }),
                    fields: [
                        { name: '👤 Applicant', value: values.targetUserTag, inline: true },
                        { name: '🛡️ Status', value: '❌ REJECTED', inline: true },
                        { name: '🧾 Rejected By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: '🆔 Verification ID', value: getVerificationFieldValue(values.verificationId), inline: true }
                    ]
                });

                await editStoredVerificationMessage(interaction.client, verificationData, updatedEmbed, []).catch(() => null);

                // Send final result to the verification result channel (mention the user above the embed)
                const finalEmbed = buildRejectedEmbed({ values, reviewerTag: `<@${interaction.user.id}>`, reviewedAt, guild, reason });
                await sendVerificationResult(interaction.client, guildId, targetUserId, finalEmbed).catch(() => null);

                // DM the user with the full rejected embed (never crash if DMs are disabled)
                const dmEmbed = buildVerificationEmbed({
                    title: '❌ Verification Rejected',
                    description: 'Your player verification request has been rejected.',
                    color: 0xE74C3C,
                    footerText: `Kakuzu Verification System • ${reviewedAt}`,
                    thumbnailUrl: interaction.client.user.displayAvatarURL({ size: 256 }),
                    fields: [
                        { name: '**Roblox Username**', value: getVerificationFieldValue(values.robloxUsername), inline: true },
                        { name: '**Kill Count**', value: getVerificationFieldValue(values.killCount), inline: true },
                        { name: '**PS Link**', value: getVerificationFieldValue(values.psLink), inline: true },
                        { name: '**Verification ID**', value: getVerificationFieldValue(values.verificationId), inline: true },
                        { name: '**Rejected By**', value: `<@${interaction.user.id}>`, inline: true },
                        { name: '**Date/Time**', value: reviewedAt, inline: true },
                        { name: '**Reason**', value: getVerificationFieldValue(reason), inline: false },
                        { name: '**Status**', value: '❌ REJECTED', inline: false }
                    ]
                });
                const dmResult = await sendVerificationDM(interaction.client, targetUserId, dmEmbed);
                if (!dmResult.delivered) {
                    console.warn(`DM rejection to ${targetUserId} could not be delivered (${dmResult.reason}). Result was still posted to the result channel.`);
                }

                return;
            }

            // ===== ANNOUNCEMENT MODAL SUBMISSION =====
            if (interaction.customId === 'announcement_modal') {
                const title = interaction.fields.getTextInputValue('ann_title');
                const description = interaction.fields.getTextInputValue('ann_description');
                const ping = interaction.fields.getTextInputValue('ann_ping');
                const bannerUrl = interaction.fields.getTextInputValue('ann_banner');

                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setDescription(description)
                    .setColor(0x2B2D31) // Discord dark gray (rules/information channel aesthetic)
                    .setTimestamp()
                    .setFooter({ text: `Announced by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) });

                // Add banner/logo as thumbnail (top right) if provided
                if (bannerUrl && bannerUrl.trim() !== '') {
                    embed.setThumbnail(bannerUrl.trim());
                }

                const payload = { embeds: [embed] };

                // Add ping content if provided
                if (ping && ping.trim() !== '') {
                    payload.content = ping.trim();
                }

                await interaction.reply(payload);
                return;
            }

            // Verification: Modal form submission
            if (interaction.customId === "verify_modal_submit") {
                // Acknowledge the interaction immediately to prevent timeout
                await interaction.deferReply({ flags: 64 }).catch(() => null);

                try {
                    // Safely get field values (won't throw if left blank)
                    const getFieldValue = (customId) => {
                        try {
                            return interaction.fields.getTextInputValue(customId) || '';
                        } catch {
                            return '';
                        }
                    };

                    const robloxUsername = getFieldValue("verify_roblox_username").trim();
                    const robloxPsLink = getFieldValue("verify_roblox_ps_link").trim();
                    const killCount = getFieldValue("verify_kill_count").trim();
                    let friendListLink = getFieldValue("verify_friend_list_link").trim();

                    // ----- Required field validation -----
                    if (!robloxUsername) {
                        return interaction.followUp({ content: '❌ **Roblox username is required.** Please fill in your Roblox username before submitting.', flags: 64 }).catch(() => null);
                    }
                    if (!robloxPsLink) {
                        return interaction.followUp({ content: '❌ **PS link is required.** Please provide your Roblox Private Server link.', flags: 64 }).catch(() => null);
                    }
                    if (!/^https?:\/\/.+/i.test(robloxPsLink)) {
                        return interaction.followUp({ content: '❌ **Invalid PS link.** Please provide a valid URL starting with http:// or https://.', flags: 64 }).catch(() => null);
                    }
                    const killCountNum = Number(killCount);
                    if (!killCount || Number.isNaN(killCountNum) || killCountNum < 0) {
                        return interaction.followUp({ content: '❌ **Invalid kill count.** Please enter a valid number (e.g. 123).', flags: 64 }).catch(() => null);
                    }
                    if (friendListLink && !/^https?:\/\/.+/i.test(friendListLink)) {
                        return interaction.followUp({ content: '❌ **Invalid friend-list link.** If provided, it must be a valid image URL (https://...).', flags: 64 }).catch(() => null);
                    }

                    // Validate the Roblox username (non-blocking; do not over-restrict)
                    const robloxValidation = robloxUsername
                        ? await robloxApi.validateAndGetAvatar(robloxUsername).catch(() => ({ success: false, error: 'Unable to reach Roblox API' }))
                        : { success: false, error: 'No username provided' };

                    const guildId = interaction.guild.id;
                    const verificationId = raidStateManager.getNextVerificationId(guildId);

                    // Save verification data as pending (persisted per guild)
                    await verificationDb.markVerified(interaction.user.id, {
                        robloxUsername: robloxUsername,
                        robloxDisplayName: robloxValidation.success ? robloxValidation.displayName : robloxUsername,
                        robloxUserId: robloxValidation.success ? robloxValidation.userId : null,
                        robloxAvatarUrl: robloxValidation.success ? robloxValidation.avatarUrl : null,
                        robloxPsLink,
                        killCount: String(killCountNum),
                        friendListLink: friendListLink || null,
                        verificationId
                    }, guildId);

                    const robloxDisplayName = robloxValidation.success ? robloxValidation.displayName : robloxUsername;
                    const robloxUserId = robloxValidation.success ? robloxValidation.userId : null;
                    const robloxProfileValue = formatRobloxProfileValue({
                        roblox_display_name: robloxDisplayName,
                        roblox_username: robloxUsername,
                        roblox_user_id: robloxUserId
                    });

                    // Always retrieve the configured verification logs channel for THIS guild.
                    // Never fall back to the interaction channel (fixes the reported bug).
                    const settings = raidStateManager.loadSettings(guildId);
                    const logsChannelId = settings.verificationLogsChannel || settings.infoChannel;
                    if (!logsChannelId) {
                        console.warn(`No verification logs channel configured for guild ${guildId}.`);
                        return interaction.followUp({ content: '❌ **No verification logs channel is configured.** Please ask a server administrator to run `/setverificationlogs` with a valid text channel.', flags: 64 }).catch(() => null);
                    }
                    const logsChannel = await interaction.client.channels.fetch(logsChannelId).catch(() => null);
                    if (!logsChannel || !logsChannel.isTextBased()) {
                        console.warn(`Verification logs channel ${logsChannelId} unavailable or invalid for guild ${guildId}.`);
                        return interaction.followUp({ content: '❌ **The configured verification logs channel is unavailable or invalid.** Please ask a server administrator to re-run `/setverificationlogs`.', flags: 64 }).catch(() => null);
                    }

                    const submittedAt = formatVerificationDate(Date.now());
                    const profileEmbed = buildVerificationEmbed({
                        title: '🆕 NEW PENDING VERIFICATION',
                        description: 'A new verification request has been submitted and is waiting for moderator review.',
                        color: 0xF59E0B,
                        footerText: `Kakuzu Verification System • ${submittedAt}`,
                        thumbnailUrl: robloxValidation.success && robloxValidation.avatarUrl ? robloxValidation.avatarUrl : interaction.user.displayAvatarURL({ size: 256 }),
                        imageUrl: friendListLink && friendListLink.match(/^https?:\/\/.+/i) ? friendListLink : null,
                        fields: [
                            { name: '👤 Applicant', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                            { name: '🆔 User ID', value: getVerificationFieldValue(interaction.user.id), inline: true },
                            { name: '🧾 Roblox Profile', value: getVerificationFieldValue(robloxProfileValue), inline: true },
                            { name: '⚔️ Kill Count', value: getVerificationFieldValue(String(killCountNum)), inline: true },
                            { name: '🔗 PS Link', value: getVerificationFieldValue(robloxPsLink), inline: true },
                            { name: '📸 Friend List', value: getVerificationFieldValue(friendListLink ? `[View Screenshot](${friendListLink})` : 'Not provided'), inline: true },
                            { name: '🛡️ Status', value: '⏳ PENDING', inline: true },
                            { name: '🆔 Verification ID', value: getVerificationFieldValue(verificationId), inline: true },
                            { name: '📅 Requested At', value: submittedAt, inline: true }
                        ]
                    });

                    const actionRow = createVerificationActionButtons(interaction.user.id);
                    const staffPing = getVerificationStaffPing(guildId);
                    const sendOptions = { embeds: [profileEmbed], components: [actionRow] };
                    if (staffPing.mention) {
                        sendOptions.content = staffPing.mention;
                        sendOptions.allowedMentions = staffPing.allowedMentions;
                    }

                    const pendingMessage = await logsChannel.send(sendOptions).catch((err) => {
                        console.warn(`Could not send pending verification to logs channel: ${err.message}`);
                        return null;
                    });
                    if (!pendingMessage) {
                        return interaction.followUp({ content: '❌ **The bot could not post your verification to the configured logs channel.** Please contact a server administrator.', flags: 64 }).catch(() => null);
                    }
                    await verificationDb.setVerificationLogMessage(interaction.user.id, logsChannel.id, pendingMessage.id, guildId);

                    const replyContent = robloxValidation.success
                        ? '✅ **Verification Submitted!** Your information has been sent to moderators for review. You will receive a DM once a decision is made.'
                        : `✅ **Verification Submitted!** Your information has been sent to moderators for review. Note: Could not validate Roblox username (${robloxValidation.error}) — you may be contacted to fix it. You will receive a DM once a decision is made.`;

                    return interaction.followUp({
                        content: replyContent,
                        flags: 64
                    }).catch(() => null);
                } catch (error) {
                    console.error('Verification modal submit error:', error);
                    return interaction.followUp({
                        content: '❌ **An error occurred while processing your verification.** Please try again.',
                        flags: 64
                    }).catch(() => null);
                }
            }

            if (interaction.customId.startsWith("raid_acceptmodal_")) {
                const targetRaidId = Number(interaction.customId.split("_")[2]);
                const helperUsername = interaction.fields.getTextInputValue("helperRobloxUsername");

                const currentRaid = raidStateManager.getRaidById(targetRaidId, interaction.guild.id);
                if (!currentRaid || currentRaid.status === "CLOSED") {
                    return interaction.reply({ content: "This raid operation is no longer active or closed.", flags: 64 }).catch(() => null);
                }

                const robloxValidation = await robloxApi.validateAndGetAvatar(helperUsername);
                if (!robloxValidation.success) {
                    return interaction.reply({ 
                        content: `❌ **Roblox Username Validation Failed**\n${robloxValidation.error}`, 
                        flags: 64 
                    });
                }

                const result = await raidStateManager.addHelper(targetRaidId, interaction.user.id, {
                    username: helperUsername,
                    displayName: robloxValidation.displayName || helperUsername,
                    userId: robloxValidation.userId || "1"
                }, interaction.guild.id);

                if (!result.success) {
                    return interaction.reply({ content: result.message, flags: 64 });
                }

                const updated = result.raid;
                const content = raidStateManager.formatRaidMessage(updated);
                const row = createRaidButtons(updated, interaction.member);
                const channel = await interaction.client.channels.fetch(updated.channelId).catch(() => null);
                if (channel) {
                    const message = await channel.messages.fetch(updated.messageId).catch(() => null);
                    if (message) await message.edit({ embeds: [content], components: [row] });
                }

                return interaction.reply({
                    content: `✅ **Raid Request Accepted!**\n- \`Raid ID:\` #${currentRaid.raidId}\n- \`Server:\` ${currentRaid.serverLink}`,
                    flags: 64
                }).catch(() => null);
            }

            if (interaction.customId === "raid_application_step1") {
                const userId = interaction.user.id;
                if (!raidStateManager.canCreateRaid(userId, interaction.guild.id)) {
                    return interaction.reply({ content: "You already have an open raid or you are blocked from creating new raids.", flags: 64 }).catch(() => null);
                }

                const region = pendingRegionSelections.get(userId);
                if (!region) {
                    pendingRegionSelections.delete(userId);
                    return interaction.reply({ content: "Please select a region before continuing.", flags: 64 }).catch(() => null);
                }

                const partial = {
                    requesterId: userId,
                    requesterTag: interaction.user.tag,
                    robloxUsername: interaction.fields.getTextInputValue("robloxUsername"),
                    serverLink: interaction.fields.getTextInputValue("serverLink"),
                    region,
                    enemyCount: interaction.fields.getTextInputValue("enemyCount"),
                    helperLimit: interaction.fields.getTextInputValue("helperLimit")
                };

                pendingRaidApplications.set(userId, partial);

                const continueButton = new ButtonBuilder()
                    .setCustomId("raid_step2_continue")
                    .setLabel("Continue to Step 2")
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(continueButton);
                return interaction.reply({
                    content: "✅ Step 1 saved! Click the button below to continue.",
                    components: [row],
                    flags: 64
                }).catch(() => null);
            }

            if (interaction.customId === "raid_application_step2") {
                const userId = interaction.user.id;
                const partial = pendingRaidApplications.get(userId);
                pendingRaidApplications.delete(userId);
                if (!partial) {
                    return interaction.reply({ content: "Raid application expired. Please start over.", flags: 64 }).catch(() => null);
                }

                const robloxUsername = partial.robloxUsername;
                const serverLink = partial.serverLink;
                const region = partial.region;
                const enemyCount = Number(partial.enemyCount);
                const helperLimit = Number(partial.helperLimit);
                const teamers = interaction.fields.getTextInputValue("teamers");
                const enemyClanNames = interaction.fields.getTextInputValue("enemyClanNames");
                const enemyClanPresent = interaction.fields.getTextInputValue("enemyClanPresent");
                const reason = interaction.fields.getTextInputValue("reason");

                if (Number.isNaN(enemyCount) || enemyCount <= 2) {
                    return interaction.reply({ content: "Enemy count must be a number greater than 2.", flags: 64 }).catch(() => null);
                }
                if (Number.isNaN(helperLimit) || helperLimit < 1 || helperLimit > 20) {
                    return interaction.reply({ content: "Helpers needed must be a number between 1 and 20.", flags: 64 }).catch(() => null);
                }
                if (!robloxUsername || !serverLink || !region || !reason) {
                    return interaction.reply({ content: "All required fields must be filled in.", flags: 64 }).catch(() => null);
                }

                const robloxValidation = await robloxApi.validateAndGetAvatar(robloxUsername);
                if (!robloxValidation.success) {
                    return interaction.reply({ 
                        content: `❌ **Roblox Username Validation Failed**\n${robloxValidation.error}`, 
                        flags: 64 
                    });
                }

                const raid = raidStateManager.createRaid({
                    requesterId: userId,
                    requesterTag: interaction.user.tag,
                    robloxUsername,
                    robloxDisplayName: robloxValidation.displayName || robloxUsername,
                    robloxUserId: robloxValidation.userId || "1",
                    robloxAvatarUrl: robloxValidation.avatarUrl,
                    serverLink,
                    region,
                    enemyCount,
                    teamers,
                    enemyClanNames,
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
                    return interaction.reply({ content: '❌ Raid channel is not configured. Please run `/setchannels` and set the `raid_channel` first (Raid Alert channel).', flags: 64 }).catch(() => null);
                }

                const targetChannel = await interaction.client.channels.fetch(settings.raidChannel).catch(() => null);

                if (!targetChannel || !targetChannel.isTextBased()) {
                    return interaction.reply({ content: '❌ Configured raid channel is unavailable or not a text channel. Please reconfigure it with `/setchannels`.', flags: 64 }).catch(() => null);
                }

                const completionEmbed = new EmbedBuilder()
                    .setTitle('🚀 Raid Request Successfully Launched!')
                    .setDescription(`Operator <@${userId}> has successfully deployed a combat request!`)
                    .addFields([
                        { name: 'Raid Registry ID', value: `\`#${raid.raidId}\``, inline: true },
                        { name: 'Roblox Identity', value: `\`${robloxUsername}\``, inline: true },
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
};