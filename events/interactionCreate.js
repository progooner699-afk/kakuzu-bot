const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionsBitField
} = require("discord.js");
const raidStateManager = require("../handlers/raidStateManager");
const robloxApi = require("../handlers/robloxApi");
const pendingRaidApplications = new Map();

const RAID_CLOSE_ROLES = [
    'Administrator',
    'Management Supervisor',
    'Community Manager',
    'Senior Moderator'
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

            const [prefix, action, idString] = customId.split("_");
            const raidId = Number(idString);
            if (prefix !== "raid" || Number.isNaN(raidId)) return;

            const raid = raidStateManager.getRaidById(raidId);
            if (!raid) {
                return interaction.reply({ content: "Raid not found.", flags: 64 });
            }

            if (action === "accept") {
                if (raid.status === "CLOSED") {
                    return interaction.reply({ content: "This raid is closed and cannot accept helpers.", flags: 64 });
                }
                const result = await raidStateManager.addHelper(raidId, interaction.user.id);
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
                    console.error('Failed to publish leaderboard:', error);
                }
                // Commented out plain text messages to keep leaderboard channel clean
                // const settings = raidStateManager.loadSettings();
                // if (settings.leaderboardLogChannel) {
                //     const logChannel = await interaction.client.channels.fetch(settings.leaderboardLogChannel).catch(() => null);
                //     if (logChannel && logChannel.isTextBased()) {
                //         await logChannel.send(`👤 <@${interaction.user.id}> has accepted a raid! Total Raids: ${result.totalRaids}`);
                //     }
                // }

                return interaction.reply({
                    content: `- \`Raid ID          |\` ${raid.raidId}\n- \`Status           |\` You have accepted this raid!\n- \`Raid Server Link |\` ${raid.serverLink}`,
                    ephemeral: true
                });
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
                return interaction.reply({ content: "You have left the raid.", flags: 64 });
            }

            if (action === "close") {
                const member = interaction.member;
                if (!canCloseRaid(member, raid)) {
                    return interaction.reply({ content: "Only the raid requester or a staff member with Administrator, Management Supervisor, Community Manager, or Senior Moderator permissions can close this raid.", flags: 64 });
                }
                const updated = raidStateManager.closeRaid(raidId);
                if (!updated) {
                    return interaction.reply({ content: "Unable to close the raid.", flags: 64 });
                }
                const content = raidStateManager.formatRaidMessage(updated);
                const row = createRaidButtons(updated, interaction.member);
                const channel = await interaction.client.channels.fetch(updated.channelId).catch(() => null);
                if (channel) {
                    const message = await channel.messages.fetch(updated.messageId).catch(() => null);
                    if (message) await message.edit({ embeds: [content], components: [row] });
                }
                return interaction.reply({ content: "Raid has been closed.", flags: 64 });
            }
        }

        if (interaction.isModalSubmit()) {
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

                // Validate Roblox username and fetch avatar
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

                await interaction.reply({ content: `Raid request submitted successfully and posted as #${raid.raidId}.`, flags: 64 });
                return raidStateManager.publishLeaderboard(interaction.client);
            }
        }
    }
};
