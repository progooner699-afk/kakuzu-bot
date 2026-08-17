/**
 * [TEMPORARY] Raid Alert Test Command
 *
 * Posts a fake raid alert embed with testing data to the configured
 * raid channel. Used for visually testing the embed layout.
 * Delete this file when no longer needed.
 */
const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,

} = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');
const raidV2 = require('../handlers/raidV2');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('raidtest')
        .setDescription('Test fake raid alert embed'),

    async execute(interaction) {
        // Build a fake raid object with testing data
        const fakeRaid = {
            raidId: 999,
            status: 'OPEN',
            requesterId: interaction.user.id,
            requesterTag: interaction.user.tag,
            targetGame: 'tsb',
            robloxUsername: 'TestUser',
            robloxDisplayName: 'TestUser',
            robloxUserId: '12345678',
            robloxAvatarUrl: interaction.user.displayAvatarURL({ size: 256 }),
            serverLink: 'https://www.roblox.com/games/1153846701',
            placeId: '1153846701',
            serverId: 'test-job-id-abc123',
            gameThumbnailUrl: '',
            region: 'MUMBAI',
            enemyCount: 3,
            teamers: '',
            enemyClanNames: 'ShadowReapers',
            enemyNames: 'PlayerOne, PlayerTwo, PlayerThree',
            enemyClanPresent: 'NO',
            reason: 'This is a test raid alert for embed layout testing.',
            helperLimit: 3,
            helpers: [
                {
                    userId: interaction.user.id,
                    robloxUsername: 'TestUser',
                    robloxDisplayName: 'TestUser',
                    robloxUserId: '12345678',
                    robloxAvatarUrl: null,
                    joinTime: Date.now() - 60000,
                    timeSpentSeconds: 75
                }
            ],
            messageId: null,
            channelId: null,
            createdAt: Date.now() - 120000
        };

        // Generate the raid alert embed using the real formatter
        const embeds = raidStateManager.formatRaidMessage(fakeRaid, interaction.guild.id);

        // Simple test buttons
        const joinUrl = 'https://www.roblox.com/games/start?placeId=' + fakeRaid.placeId;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel('JOIN SERVER')
                .setURL(joinUrl),
            new ButtonBuilder()
                .setCustomId('raid_accept_999')
                .setLabel('Join Raid')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('close_raid_999')
                .setLabel('CLOSE RAID')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );

        // Get configured raid channel
        const settings = raidStateManager.loadSettings(interaction.guild.id);

        if (!settings.raidChannel) {
            return interaction.reply({
                content: 'No raid channel configured. Run /setchannels first.',
                flags: 64
            });
        }

        const targetChannel = await interaction.client.channels.fetch(settings.raidChannel).catch(() => null);

        if (!targetChannel || !targetChannel.isTextBased()) {
            return interaction.reply({
                content: 'Configured raid channel is unavailable.',
                flags: 64
            });
        }

        let v2Posted = false;
        const v2Payload = await raidV2.buildRaidAlertPayload(fakeRaid, row);
        try {
            await targetChannel.send(v2Payload);
            v2Posted = true;
        } catch (v2Err) {
            console.warn('Components V2 send failed, falling back to embeds:', (v2Err && v2Err.message) || v2Err);
            await targetChannel.send({ embeds: embeds, components: [row] });
        }
        await interaction.reply({
            content: 'Test raid alert posted to channel — Raid #999 (fake data) ' + (v2Posted ? '(native V2)' : '(embed fallback)'),
            flags: 64
        });
    }
};
