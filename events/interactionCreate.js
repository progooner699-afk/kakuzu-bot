const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");
const raidStateManager = require("../handlers/raidStateManager");
const robloxApi = require("../handlers/robloxApi");
const { pendingResultUploads } = require("../handlers/resultUploadState");
const pendingRaidApplications = new Map();
const pendingRegionSelections = new Map();

function createRaidComponents(raid, member = null) {
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

    const close = new ButtonBuilder()
        .setCustomId(`raid_close_${raid.raidId}`)
        .setLabel("Close Raid")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(raid.status === "CLOSED");

    const win = new ButtonBuilder()
        .setCustomId(`raid_result_win_${raid.raidId}`)
        .setLabel("Win")
        .setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(raid.resultOutcome) || raid.status === "CLOSED");

    const loss = new ButtonBuilder()
        .setCustomId(`raid_result_loss_${raid.raidId}`)
        .setLabel("Loss")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(Boolean(raid.resultOutcome) || raid.status === "CLOSED");

    const draw = new ButtonBuilder()
        .setCustomId(`raid_result_draw_${raid.raidId}`)
        .setLabel("Draw")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(Boolean(raid.resultOutcome) || raid.status === "CLOSED");

    const actionRow = new ActionRowBuilder().addComponents(accept, leave, close);
    const resultRow = new ActionRowBuilder().addComponents(win, loss, draw);
    return [actionRow, resultRow];
}

async function updateRaidMessage(client, raid, member = null) {
    if (!raid.channelId || !raid.messageId) return null;
    const channel = await client.channels.fetch(raid.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return null;
    const message = await channel.messages.fetch(raid.messageId).catch(() => null);
    if (!message) return null;
    const embed = raid.status === "CLOSED" || raid.resultOutcome
        ? raidStateManager.formatRaidResultEmbed(raid)
        : raidStateManager.formatRaidMessage(raid);
    const components = raid.status === "CLOSED" ? [] : createRaidComponents(raid, member);
    await message.edit({ embeds: [embed], components });
    return message;
}

module.exports = {
    name: "interactionCreate",
    async execute(interaction, client) {
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
                const regionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("raid_region_ASIA").setLabel("ASIA").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("raid_region_EU").setLabel("EU").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("raid_region_NA").setLabel("NA").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("raid_region_SA").setLabel("SA").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("raid_region_AUST").setLabel("AUST").setStyle(ButtonStyle.Primary)
                );
                return interaction.reply({
                    content: "Select the region for this raid request.",
                    components: [regionRow],
                    ephemeral: true
                });
            }

            if (customId.startsWith("raid_region_")) {
                const region = customId.replace("raid_region_", "").toUpperCase();
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
                            .setCustomId("region")
                            .setLabel("Region")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setValue(region)
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

            const resultMatch = customId.match(/^raid_result_(win|loss|draw)_(\d+)$/);
            if (resultMatch) {
                const raidId = Number(resultMatch[2]);
                const raid = raidStateManager.getRaidById(raidId);
                if (!raid) {
                    return interaction.reply({ content: "Raid not found.", ephemeral: true });
                }
                if (raid.status === "CLOSED") {
                    return interaction.reply({ content: "This raid is already closed.", ephemeral: true });
                }
                const outcome = resultMatch[1].toUpperCase();
                raidStateManager.setRaidResult(raidId, { outcome, imageUrl: null, note: '' });
                pendingResultUploads.set(interaction.user.id, {
                    raidId,
                    outcome,
                    channelId: raid.channelId,
                    messageId: raid.messageId
                });
                await updateRaidMessage(client, raidStateManager.getRaidById(raidId), interaction.member);
                return interaction.reply({
                    content: `Result set to ${outcome}. Please upload a screenshot for this raid result.`,
                    ephemeral: true
                });
            }

            const [prefix, action, idString] = customId.split("_");
            const raidId = Number(idString);
            if (prefix !== "raid" || Number.isNaN(raidId)) return;

            const raid = raidStateManager.getRaidById(raidId);
            if (!raid) {
                return interaction.reply({ content: "Raid not found.", ephemeral: true });
            }

            if (action === "accept") {
                if (raid.status === "CLOSED") {
                    return interaction.reply({ content: "This raid is closed and cannot accept helpers.", ephemeral: true });
                }
                const result = await raidStateManager.addHelper(raidId, interaction.user.id);
                if (!result.success) {
                    return interaction.reply({ content: result.message, ephemeral: true });
                }
                const updated = result.raid;
                await updateRaidMessage(client, updated, interaction.member);
                try {
                    await raidStateManager.publishLeaderboard(client);
                } catch (error) {
                    console.error('Failed to publish leaderboard:', error);
                }
                return interaction.reply({
                    content: `- \`Raid ID          |\` ${raid.raidId}\n- \`Status           |\` You have accepted this raid!\n- \`Raid Server Link |\` ${raid.serverLink}`,
                    ephemeral: true
                });
            }

            if (action === "leave") {
                const result = raidStateManager.removeHelper(raidId, interaction.user.id);
                if (!result.success) {
                    return interaction.reply({ content: result.message, ephemeral: true });
                }
                const updated = result.raid;
                await updateRaidMessage(client, updated, interaction.member);
                return interaction.reply({ content: "You have left the raid.", ephemeral: true });
            }

            if (action === "close") {
                const member = interaction.member;
                if (!raidStateManager.canCloseRaid(member, raid)) {
                    return interaction.reply({ content: "Access Denied: Only the Raid Leader or an Administrator can close this.", ephemeral: true });
                }
                const updated = raidStateManager.closeRaid(raidId);
                if (!updated) {
                    return interaction.reply({ content: "Unable to close the raid.", ephemeral: true });
                }
                await updateRaidMessage(client, updated, interaction.member);
                return interaction.reply({ content: "Raid has been closed.", ephemeral: true });
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === "raid_application_step1") {
                const userId = interaction.user.id;
                if (!raidStateManager.canCreateRaid(userId)) {
                    return interaction.reply({ content: "You already have an open raid or you are blocked from creating new raids.", ephemeral: true });
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
                pendingRegionSelections.delete(userId);

                const continueButton = new ButtonBuilder()
                    .setCustomId("raid_step2_continue")
                    .setLabel("Continue to Step 2")
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(continueButton);
                return interaction.reply({
                    content: "✅ Step 1 saved! Click the button below to continue.",
                    components: [row],
                    ephemeral: true
                });
            }

            if (interaction.customId === "raid_application_step2") {
                const userId = interaction.user.id;
                const partial = pendingRaidApplications.get(userId);
                pendingRaidApplications.delete(userId);
                if (!partial) {
                    return interaction.reply({ content: "Raid application expired. Please start over.", ephemeral: true });
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
                    return interaction.reply({ content: "Enemy count must be a number greater than 2.", ephemeral: true });
                }
                if (Number.isNaN(helperLimit) || helperLimit < 1 || helperLimit > 20) {
                    return interaction.reply({ content: "Helpers needed must be a number between 1 and 20.", ephemeral: true });
                }
                if (!robloxUsername || !serverLink || !region || !reason) {
                    return interaction.reply({ content: "All required fields must be filled in.", ephemeral: true });
                }

                const robloxValidation = await robloxApi.validateAndGetAvatar(robloxUsername);
                if (!robloxValidation.success) {
                    return interaction.reply({
                        content: `❌ **Roblox Username Validation Failed**\n${robloxValidation.error}`,
                        ephemeral: true
                    });
                }

                const raid = raidStateManager.createRaid({
                    requesterId: userId,
                    requesterTag: interaction.user.tag,
                    robloxUsername,
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
                const components = createRaidComponents(raid, interaction.member);
                const targetChannelId = settings.raidChannel || interaction.channelId;
                const targetChannel = await interaction.client.channels.fetch(targetChannelId).catch(() => null);

                if (!targetChannel || !targetChannel.isTextBased()) {
                    return interaction.reply({ content: "Raid could not be posted because the raid channel is not set or is unavailable.", ephemeral: true });
                }

                const roleMention = raidStateManager.getRegionRoleMention(raid.region);
                const message = await targetChannel.send({
                    content: roleMention || 'Raid request submitted',
                    embeds: [content],
                    components,
                    allowedMentions: roleMention ? { roles: [raidStateManager.getRegionRoleId(raid.region)] } : undefined
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

                await interaction.reply({ content: `Raid request submitted successfully and posted as #${raid.raidId}.`, ephemeral: true });
                return raidStateManager.publishLeaderboard(interaction.client);
            }
        }
    }
};
