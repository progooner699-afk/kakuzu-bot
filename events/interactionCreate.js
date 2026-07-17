const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionsBitField,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require("discord.js");
const raidStateManager = require("../handlers/raidStateManager");
const robloxApi = require("../handlers/robloxApi");
const verificationDb = require("../handlers/verificationDb");
const pendingRaidApplications = new Map();
const pendingRegionSelections = new Map();

const REGION_ROLE_IDS = {
    NA: '1516664149793439775',
    SA: '1516664182194307082',
    ASIA: '1516663854354923620',
    EU: '1516664062438674462',
    AUST: '1522551121615523910'
};

// Whitelisted roles updated with Supreme Leader included
const RAID_CLOSE_ROLES = [
    'Administrator',
    'Management Supervisor',
    'Community Manager',
    'Senior Moderator',
    '💣 ‖ SUPREME LEADER'
];

function canCloseRaid(member, raid) {
    if (!member || !raid) return false;
    if (member.id === raid.requesterId) return true;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return member.roles.cache.some(role => RAID_CLOSE_ROLES.includes(role.name));
}

function normalizeRegion(region) {
    const value = String(region || '').trim().toUpperCase();
    if (value === 'AS') return 'ASIA';
    if (value === 'EUROPE') return 'EU';
    if (value === 'US' || value === 'USA' || value === 'NORTH AMERICA') return 'NA';
    if (value === 'SOUTH AMERICA') return 'SA';
    if (value === 'AUS' || value === 'AUSTRALIA') return 'AUST';
    return value;
}

function getRegionRoleInfo(region) {
    const normalized = normalizeRegion(region);
    const roleId = REGION_ROLE_IDS[normalized] || null;
    return roleId ? { roleId, mention: `<@&${roleId}>` } : { roleId: null, mention: null };
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
                            .setLabel("Friend List Image Link (Screenshot URL)")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
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

            const raid = raidStateManager.getRaidById(raidId);
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
                const result = raidStateManager.removeHelper(raidId, interaction.user.id);
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
                const activeRaid = raidStateManager.getRaidById(raidId);
                if (!activeRaid || activeRaid.status === 'CLOSED') {
                    return interaction.reply({ content: '❌ This raid record has already been locked.', flags: 64 }).catch(() => null);
                }

                raidStateManager.closeRaid(raidId);
                activeRaid.status = 'CLOSED';

                const settings = raidStateManager.loadSettings();
                const raidsData = raidStateManager.loadRaids();

                if (!raidsData.streakType) raidsData.streakType = 'NONE';
                if (!raidsData.streakCount) raidsData.streakCount = 0;

                let resultTitle = '';
                let resultColor = 0xbf0000;
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

                raidStateManager.saveRaids(raidsData);

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
                            const regionRoleInfo = getRegionRoleInfo(activeRaid.region);
                            await targetResultChannel.send({
                                content: regionRoleInfo.mention || undefined,
                                embeds: [buildReportCardEmbed(attachments)],
                                allowedMentions: regionRoleInfo.roleId ? { roles: [regionRoleInfo.roleId] } : undefined
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
                await interaction.followUp({ content: '📸 Upload any pictures or files for this raid result. Reply with `done` when finished, or just wait 30 seconds. The result will be sent automatically after.', ephemeral: true });

                const uploadedUrls = [];
                const collector = interaction.channel.createMessageCollector({
                    filter: (msg) => msg.author.id === interaction.user.id && msg.channelId === interaction.channelId,
                    time: 30000,
                    max: 20
                });

                collector.on('collect', (msg) => {
                    if (msg.attachments.size > 0) {
                        for (const attachment of msg.attachments.values()) {
                            uploadedUrls.push(attachment.url);
                        }
                    }
                    const content = msg.content?.toLowerCase().trim();
                    if (content === 'done') {
                        collector.stop('done');
                    }
                });

                collector.on('end', async () => {
                    await sendResultEmbed(uploadedUrls);
                });

                return;
            }
        }

        if (interaction.isModalSubmit()) {
            // ===== ANNOUNCEMENT MODAL SUBMISSION =====
            if (interaction.customId === 'announcement_modal') {
                const title = interaction.fields.getTextInputValue('ann_title');
                const description = interaction.fields.getTextInputValue('ann_description');
                const ping = interaction.fields.getTextInputValue('ann_ping');
                const bannerUrl = interaction.fields.getTextInputValue('ann_banner');

                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setDescription(description)
                    .setColor(0x9B59B6) // Purple sleek color
                    .setTimestamp()
                    .setFooter({ text: `Announcement by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ size: 64 }) });

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
                const robloxUsername = interaction.fields.getTextInputValue("verify_roblox_username");
                const robloxPsLink = interaction.fields.getTextInputValue("verify_roblox_ps_link");
                const killCount = interaction.fields.getTextInputValue("verify_kill_count");
                const friendListLink = interaction.fields.getTextInputValue("verify_friend_list_link");

                // Validate the Roblox username and get user data
                const robloxValidation = await robloxApi.validateAndGetAvatar(robloxUsername);

                // Save verification data
                await verificationDb.markVerified(interaction.user.id, {
                    robloxUsername,
                    robloxPsLink,
                    killCount,
                    friendListLink
                });

                // Send the profile embed to the configured info channel
                const settings = raidStateManager.loadSettings();
                if (settings.infoChannel) {
                    const targetChannel = await interaction.client.channels.fetch(settings.infoChannel).catch(() => null);
                    if (targetChannel && targetChannel.isTextBased()) {
                        const profileEmbed = new EmbedBuilder()
                            .setTitle('NEW VERIFICATION RECEIVED')
                            .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
                            .addFields([
                                { name: 'Discord User', value: `<@${interaction.user.id}>`, inline: false },
                                { name: 'Roblox User', value: robloxValidation.success ? `[${robloxUsername}](https://www.roblox.com/users/${robloxValidation.userId}/profile)` : `\`${robloxUsername}\``, inline: false },
                                { name: 'Private Server Link', value: `[Click to Join Private Server](${robloxPsLink})`, inline: false },
                                { name: 'Kill Count', value: killCount, inline: false },
                                { name: 'Status', value: 'STATUS: VERIFIED ✅', inline: false }
                            ])
                            .setImage(friendListLink)
                            .setFooter({ text: `Kakuzu Verification System • ${new Date().toLocaleString()}` })
                            .setColor(0x00FF00);

                        if (robloxValidation.success && robloxValidation.avatarUrl) {
                            profileEmbed.setThumbnail(robloxValidation.avatarUrl);
                        }

                        await targetChannel.send({ embeds: [profileEmbed] });
                    }
                }

                const replyContent = robloxValidation.success 
                    ? '✅ **Verification Successful!** Your information has been submitted and you are now verified.'
                    : `✅ **Verification Submitted!** Your information has been saved. Note: Could not validate Roblox username (${robloxValidation.error}). You can still proceed.`;

                return interaction.reply({
                    content: replyContent,
                    flags: 64
                }).catch(() => null);
            }

            if (interaction.customId.startsWith("raid_acceptmodal_")) {
                const targetRaidId = Number(interaction.customId.split("_")[2]);
                const helperUsername = interaction.fields.getTextInputValue("helperRobloxUsername");

                const currentRaid = raidStateManager.getRaidById(targetRaidId);
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
                });

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
                if (!raidStateManager.canCreateRaid(userId)) {
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
                    helperLimit
                });

                const settings = raidStateManager.loadSettings();
                const content = raidStateManager.formatRaidMessage(raid);
                const raidButtonRow = createRaidButtons(raid, interaction.member);
                const regionRoleInfo = getRegionRoleInfo(raid.region);
                const targetChannelId = settings.raidChannel || interaction.channelId;
                const targetChannel = await interaction.client.channels.fetch(targetChannelId).catch(() => null);

                if (!targetChannel || !targetChannel.isTextBased()) {
                    return interaction.reply({ content: "Raid could not be posted because the raid channel is not set or is unavailable.", flags: 64 }).catch(() => null);
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
                    allowedMentions: regionRoleInfo.roleId ? { roles: [regionRoleInfo.roleId] } : undefined
                });
                raidStateManager.updateRaidMessageReference(raid.raidId, targetChannel.id, message.id);

                // Removed mass DM to all guild members - this caused rate limits and potential bot bans.
                // Instead, the raid alert is posted in the configured raid channel with role mentions.
            }
        }
    }
};