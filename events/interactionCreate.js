const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionsBitField,
    EmbedBuilder
} = require("discord.js");
const raidStateManager = require("../handlers/raidStateManager");
const robloxApi = require("../handlers/robloxApi");
const pendingRaidApplications = new Map();

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
                    await interaction.reply({ content: 'An error occurred while executing that command.', ephemeral: true });
                } else {
                    await interaction.followUp({ content: 'An error occurred while executing that command.', ephemeral: true });
                }
            }
            return;
        }

        if (interaction.isButton()) {
            const customId = interaction.customId;
            
            if (customId === "request_raid") {
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
                            .setCustomId("region")
                            .setLabel("Region")
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
                return interaction.reply({ content: "Raid not found.", flags: 64 });
            }

            if (action === "accept") {
                if (raid.status === "CLOSED") {
                    return interaction.reply({ content: "This raid is closed and cannot accept helpers.", flags: 64 });
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
                return interaction.showModal(acceptModal);
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

                try {
                    await raidStateManager.publishLeaderboard(interaction.client);
                } catch (error) {
                    console.error('Failed to update leaderboard on leave:', error);
                }

                return interaction.reply({ content: "You have left the raid.", flags: 64 });
            }

            if (action === "close") {
                const member = interaction.member;
                if (!canCloseRaid(member, raid)) {
                    return interaction.reply({ content: "Only the raid requester or an authorized staff member can close this raid.", flags: 64 });
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
                });
            }

            if (action === "outcome") {
                const activeRaid = raidStateManager.getRaidById(raidId);
                if (!activeRaid || activeRaid.status === 'CLOSED') {
                    return interaction.reply({ content: '❌ This raid record has already been locked.', flags: 64 });
                }

                raidStateManager.closeRaid(raidId);
                activeRaid.status = 'CLOSED';

                const settings = raidStateManager.loadSettings();
                // FIX: Adjusted to correctly call loadRaids from the state manager import
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

                const reportCardEmbed = new EmbedBuilder()
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

                if (settings.resultChannel) {
                    const targetResultChannel = await interaction.client.channels.fetch(settings.resultChannel).catch(() => null);
                    if (targetResultChannel && targetResultChannel.isTextBased()) {
                        await targetResultChannel.send({ embeds: [reportCardEmbed] });
                    }
                }

                const alertChannel = await interaction.client.channels.fetch(activeRaid.channelId).catch(() => null);
                if (alertChannel) {
                    const baseAlertMsg = await alertChannel.messages.fetch(activeRaid.messageId).catch(() => null);
                    if (baseAlertMsg) {
                        const updatedAlertEmbed = raidStateManager.formatRaidMessage(activeRaid);
                        const cleanClosedRow = createRaidButtons(activeRaid, interaction.member);
                        await baseAlertMsg.edit({ embeds: [updatedAlertEmbed], components: [cleanClosedRow] }).catch(() => null);
                    }
                }

                // Wipes out outcome option panel buttons so users can't spam them again
                await interaction.update({ content: `✅ Combat operation logs compiled as **${outcome.toUpperCase()}**!`, components: [] });
                return raidStateManager.publishLeaderboard(interaction.client);
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith("raid_acceptmodal_")) {
                const targetRaidId = Number(interaction.customId.split("_")[2]);
                const helperUsername = interaction.fields.getTextInputValue("helperRobloxUsername");

                const currentRaid = raidStateManager.getRaidById(targetRaidId);
                if (!currentRaid || currentRaid.status === "CLOSED") {
                    return interaction.reply({ content: "This raid operation is no longer active or closed.", flags: 64 });
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

                try {
                    await raidStateManager.publishLeaderboard(interaction.client);
                } catch (error) {
                    console.error('Failed to publish leaderboard live updates:', error);
                }

                return interaction.reply({
                    content: `✅ **Raid Request Accepted!**\n- \`Raid ID:\` #${currentRaid.raidId}\n- \`Server:\` ${currentRaid.serverLink}`,
                    flags: 64
                });
            }

            if (interaction.customId === "raid_application_step1") {
                const userId = interaction.user.id;
                if (!raidStateManager.canCreateRaid(userId)) {
                    return interaction.reply({ content: "You already have an open raid or you are blocked from creating new raids.", flags: 64 });
                }

                const partial = {
                    requesterId: userId,
                    requesterTag: interaction.user.tag,
                    robloxUsername: interaction.fields.getTextInputValue("robloxUsername"),
                    serverLink: interaction.fields.getTextInputValue("serverLink"),
                    region: interaction.fields.getTextInputValue("region"),
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
                });
            }

            if (interaction.customId === "raid_application_step2") {
                const userId = interaction.user.id;
                const partial = pendingRaidApplications.get(userId);
                pendingRaidApplications.delete(userId);
                if (!partial) {
                    return interaction.reply({ content: "Raid application expired. Please start over.", flags: 64 });
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
                    return interaction.reply({ content: "Enemy count must be a number greater than 2.", flags: 64 });
                }
                if (Number.isNaN(helperLimit) || helperLimit < 1 || helperLimit > 20) {
                    return interaction.reply({ content: "Helpers needed must be a number between 1 and 20.", flags: 64 });
                }
                if (!robloxUsername || !serverLink || !region || !reason) {
                    return interaction.reply({ content: "All required fields must be filled in.", flags: 64 });
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
                const targetChannelId = settings.raidChannel || interaction.channelId;
                const targetChannel = await interaction.client.channels.fetch(targetChannelId).catch(() => null);

                if (!targetChannel || !targetChannel.isTextBased()) {
                    return interaction.reply({ content: "Raid could not be posted because the raid channel is not set or is unavailable.", flags: 64 });
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

                // Sets launch confirmation message back to fully ephemeral with a native dismiss button!
                await interaction.reply({ embeds: [completionEmbed], flags: 64 });

                const message = await targetChannel.send({
                    content: '@everyone',
                    embeds: [content],
                    components: [raidButtonRow],
                    allowedMentions: { parse: ['everyone'] }
                });
                raidStateManager.updateRaidMessageReference(raid.raidId, targetChannel.id, message.id);

                if (interaction.guild) {
                    try {
                        await interaction.guild.members.fetch();
                        const dmText = '🚨 EMERGENCY RAID NOTIFICATION 🚨\n\nakatsuki';
                        for (const member of interaction.guild.members.cache.values()) {
                            if (member.user.bot) continue;
                            member.send(dmText).catch(() => null);
                        }
                    } catch (dmError) {
                        console.error('Failed to DM raid notification to members:', dmError);
                    }
                }

                return raidStateManager.publishLeaderboard(interaction.client);
            }
        }
    }
};