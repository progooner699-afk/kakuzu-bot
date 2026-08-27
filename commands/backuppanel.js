'use strict';

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

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
module.exports = {
    data: new SlashCommandBuilder()
        .setName('backuppanel')
        .setDescription('Post the raid/backup request info panel with action buttons.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
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

        // Welcome (no heading — opening paragraph).
        contents.push(text(
            '> Welcome to the backup panel. This is where the server calls for help, mobilizes against raiders, or organizes a strike of its own. Built to keep response fast and coordination clean.'
        ));
        contents.push(separator());

        // What is this
        contents.push(text(
            '# ' + EMOJI_WHAT_IS_THIS + ' What is this' + NL + NL +
            '> This panel exists for three situations: you\'re currently getting teamed on and need numbers fast, an enemy clan has started raiding your server or territory, or your own clan wants to organize and launch a raid on someone else. One button, and the call goes out.'
        ));
        contents.push(separator());

        // Rules
        contents.push(text(
            '# ' + EMOJI_RULES + ' Rules' + NL + NL +
            '> No spamming requests — one active call at a time per user. No false raid calls or crying wolf to pull people away from what they\'re doing. Repeated misuse results in a warning, then a ban from using this system entirely.'
        ));
        contents.push(separator());

        // What happens when you request
        contents.push(text(
            '# ' + EMOJI_WHAT_HAPPENS + ' What happens when you request' + NL + NL +
            '> The moment you press request, the bot instantly generates the live Roblox server link. If your Roblox account is already linked, your username is auto-filled into the call so responders know exactly who\'s asking and where to land.'
        ));
        contents.push(separator());

        // Before you start
        contents.push(text(
            '# ' + EMOJI_BEFORE_YOU_START + ' Before you start' + NL + NL +
            '> You need to link your Roblox account once before this system will work for you. It\'s a one-time setup — after that, every future call auto-fills your info with zero extra steps.'
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

        await interaction.reply({
            flags: BACKUP_PANEL_V2_FLAGS,
            components: [container]
        });
    }
};