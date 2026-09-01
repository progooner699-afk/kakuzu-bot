'use strict';

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder
} = require('discord.js');

const path = require('path');
const fs = require('fs');

// Message flag required to enable native Components V2 (Separator etc).
// NOTE: with this flag Discord DISABLES content + embeds, so the whole panel is
// built from native v2 components inside a single Container.
const BACKUP_PANEL_V2_FLAGS = 1 << 15;

// Accent color for the Container's left color bar (panel red).
const PANEL_ACCENT_COLOR = 0x8B0000;

// Runtime newline used while composing TextDisplay content (avoids escape
// sequence mangling in the source file itself).
const NL = String.fromCharCode(10);

/*
 * ALERT_EMOJI_GIF_URL is uploaded as a custom server emoji (Server Settings →
 * Emoji → Upload) and referenced inline by its custom emoji code below, not as
 * a raw image URL.
 *   src: https://cdn.discordapp.com/attachments/1534458060721098846/1542464164105166899/alert_1.gif
 */
const ALERT_EMOJI = '<:alert:0>'; // TODO: replace `0` with the uploaded emoji's ID

/*
 * Per-section title emojis. Each source image below must be uploaded as a
 * custom server emoji (Server Settings → Emoji → Upload) and referenced by its
 * resulting <:name:id> code directly before each section title text.
 */
// "What is this" source image:
//   https://cdn.discordapp.com/attachments/1534458060721098846/1542466304609493022/ewhatcj.PNG
const EMOJI_WHAT_IS_THIS = '<:whatisthis:1542514625218609213>'; // uploaded emoji code

// "Rules" source image:
//   https://cdn.discordapp.com/attachments/1534458060721098846/1542506358040592464/peporeadrules56.PNG
const EMOJI_RULES = '<:rules:1542514498018087064>'; // uploaded emoji code

// "What happens when you request" source image:
//   https://cdn.discordapp.com/attachments/1534458060721098846/1542507690780270592/talkingtoawall80.GIF
const EMOJI_WHAT_HAPPENS = '<:whathappens:1542517668878221342>'; // uploaded emoji code

// "Before you start" source image:
//   https://cdn.discordapp.com/attachments/1534458060721098846/1542508228175204382/stop.PNG
const EMOJI_BEFORE_YOU_START = '<:beforeyoustart:1542514313384956016>'; // uploaded emoji code

// "Features & Support" title emoji — NEW title, list style. Swap the 📋 for a
// custom uploaded <:name:id> emoji if you want a branded one here.
const EMOJI_FEATURES = '📋'; // list emoji for the features title

// Wide banner GIF shown at the very top INSIDE the V2 panel. The old hosted
// Discord CDN link expired (404), so the actual GIF is bundled in the repo at
// assets/backup-banner.gif, attached to the panel message itself, and rendered
// by a full-width MediaGallery component (type 12) as the first component.
const PANEL_BANNER_FILE = path.join(__dirname, '..', 'assets', 'backup-banner.gif');
const PANEL_BANNER_NAME = 'backup-banner.gif';

// The panel is NOT posted by the bot account itself. /backuppanel asks (via an
// ephemeral channel-select) which channel to post in, then the panel is sent
// through a webhook named BACKUP_PANEL_WEBHOOK_NAME so it appears under a
// "dummy profile" instead of the bot.
const BACKUP_PANEL_WEBHOOK_NAME = 'backuppanel';

// Avatar image for that dummy profile (the red BACKUPPANNEL logo). Drop the
// image at assets/backuppanel-avatar.png and it is applied to the webhook
// automatically (on create, or on the first post if the webhook has no avatar
// yet). If the file is absent the webhook just uses Discord's default avatar.
const BACKUP_PANEL_AVATAR_FILE = path.join(__dirname, '..', 'assets', 'backuppanel-avatar.png');

// Reads the dummy-profile avatar from disk, or returns null when it is missing.
function getAvatarBuffer() {
    try {
        if (fs.existsSync(BACKUP_PANEL_AVATAR_FILE)) {
            return fs.readFileSync(BACKUP_PANEL_AVATAR_FILE);
        }
    } catch (err) {
        console.error('Failed to read backup panel avatar:', err.message);
    }
    return null;
}

// Builds the full Components V2 payload for the backup panel (container +
// banner attachment). Shared by the /backuppanel command flow and the
// post_backuppanel channel-select handler in events/interactionCreate.js.
function buildBackupPanelPayload() {
    // Native v2 message building blocks.
    const text = function (content) {
        return new TextDisplayBuilder().setContent(content).toJSON(); // type 10
    };
        const separator = function () {
            return new SeparatorBuilder() // type 14
                .setDivider(true)
                .setSpacing(SeparatorSpacingSize.Small)
                .toJSON();
        };

        // Single Container that carries the whole panel (accent color bar on the
        // left). Serialized empty first; raw section/separator/row JSON is
        // attached afterwards, matching handlers/raidV2.js.
        const container = new ContainerBuilder().setAccentColor(PANEL_ACCENT_COLOR).toJSON();
        container.size = 'large';

        const contents = [];

        // Banner GIF as the first component of the panel — full-width image
        // (MediaGallery, type 12), NO separator around it, riding the same
        // single V2 message as the rest of the panel.
        contents.push(new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder()
                .setURL('attachment://' + PANEL_BANNER_NAME)
        ).toJSON());

        // About this panel
        contents.push(text(
            '# ' + EMOJI_WHAT_IS_THIS + ' ABOUT THIS PANEL' + NL + NL +
            '> Need assistance? Use this panel to call for backup when you’re outnumbered, being teamed on, or facing a clan raid in a battleground game. Send a request and let your clan know where help is needed.'
        ));
        contents.push(separator());

        // Features & Support
        contents.push(text(
            '# ' + EMOJI_FEATURES + ' FEATURES & SUPPORT' + NL + NL +
            '> • **Automatic server links** — No copying or pasting. The bot generates a join link for your current server.' + NL +
            '> • **Automatic player details** — Your linked Roblox account provides your username and profile information.' + NL +
            '> • **Automatic backup alerts** — The bot pings clan members to notify them that you need support.' + NL +
            '>' + NL +
            '> 🛠️ **Want this bot in your clan?** Join our **Support Server**: https://discord.gg/6zWMf3s9BD' + NL +
            '> 🌐 **Community:** Join **BL Clanning Community**: https://discord.gg/bEtnN6adh4'
        ));
        contents.push(separator());

        // Request Rules
        contents.push(text(
            '# ' + EMOJI_RULES + ' REQUEST RULES' + NL + NL +
            '> • Only request backup when you actually need assistance. False requests and spam are not allowed.' + NL +
            '> • Use your own main Roblox account when requesting backup.' + NL +
            '> • Help other members before requesting support yourself. This system depends on everyone contributing—give help to receive help.'
        ));
        contents.push(separator());

        // How requests work
        contents.push(text(
            '# ' + EMOJI_WHAT_HAPPENS + ' HOW REQUESTS WORK' + NL + NL +
            '> When you press **Raid Request**, the bot automatically prepares your server region, server join link, Roblox username, display name, and profile picture.' + NL +
            '>' + NL +
            '> These details appear in your backup alert so members can identify who needs assistance and which server to join.'
        ));
        contents.push(separator());

        // Before calling for backup
        contents.push(text(
            '# ' + EMOJI_BEFORE_YOU_START + ' BEFORE CALLING FOR BACKUP' + NL + NL +
            '> First, connect your Roblox account using the **Link** button below. This is a **one-time setup**.' + NL +
            '>' + NL +
            '> Once linked, you can request backup without entering your username or pasting server links. You’ll only be asked for the **enemy’s name** and the **enemy clan’s name**—the bot handles the remaining details.'
        ));
        contents.push(separator());

        // Request backup call-to-action. The button row sits directly beneath it
        // (no separator gap) so the buttons read as part of this same block.
        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('request_backup')
                .setLabel('Request backup')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('link_roblox')
                .setLabel('Link Roblox account')
                .setStyle(ButtonStyle.Secondary)
        );

        contents.push(text(ALERT_EMOJI + ' Request backup by clicking the button below.'));
        contents.push(buttonRow.toJSON());

        container.components = contents;

        // ONE message: the banner GIF is attached to this same message and
        // rendered inside the panel by the MediaGallery component above
        // (attachment:// URLs resolve only against files sent with the message).
        return {
            flags: BACKUP_PANEL_V2_FLAGS,
            components: [container],
            files: [{ attachment: PANEL_BANNER_FILE, name: PANEL_BANNER_NAME }]
        };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('backuppanel')
        .setDescription('Post the raid/backup request info panel with action buttons.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    buildBackupPanelPayload,
    BACKUP_PANEL_WEBHOOK_NAME,
    BACKUP_PANEL_V2_FLAGS,
    getBackupPanelAvatarBuffer: getAvatarBuffer,
    // The command reply is the ephemeral channel-picker (instant) — no DB or
    // network work before it, so it opts out of the dispatcher's auto-defer to
    // keep the reply path identical to before.
    deferFirst: false,
    async execute(interaction) {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({
                content: 'You need the **Manage Server** permission to post the backup panel.',
                flags: 64
            });
        }

        // Ephemeral channel picker — the panel is NOT posted by the bot
        // account; after the channel is chosen the panel goes out through a
        // webhook named BACKUP_PANEL_WEBHOOK_NAME (dummy "backuppanel" profile).
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('post_backuppanel')
            .setPlaceholder('Select the channel to post the backup panel in')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

        const embed = new EmbedBuilder()
            .setTitle('📡 Backup Panel — Choose a Channel')
            .setDescription(
                'Pick the channel where the backup panel should be posted.' + NL + NL +
                'The panel will be sent through a **' + BACKUP_PANEL_WEBHOOK_NAME + '** webhook profile (not the bot account) in the channel you choose.'
            )
            .setColor(PANEL_ACCENT_COLOR);

        await interaction.reply({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(channelSelect)],
            flags: 64
        });
    }
};