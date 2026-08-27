const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

/*
 * These CDN links contain expiring query params (ex, is, hm) which are
 * intentionally stripped — Discord serves the file fine without them for
 * embed purposes. If the GIFs ever stop loading, they must be re-uploaded
 * and these base URLs refreshed.
 */
const BANNER_GIF_URL = 'https://cdn.discordapp.com/attachments/1534458060721098846/1542450307273850890/tenor_12.gif';
const SHIMMER_DIVIDER_URL = 'https://cdn.discordapp.com/attachments/1534458060721098846/1542450341445107762/shimmer_divider_red.gif';
const ALERT_EMOJI_GIF_URL = 'https://cdn.discordapp.com/attachments/1534458060721098846/1542464164105166899/alert_1.gif';

/*
 * Custom server emoji codes (upload via Server Settings → Emoji → Upload).
 * ALERT_EMOJI_GIF_URL must be uploaded too, then referenced below as a custom
 * emoji (<:name:id>) rather than a raw image URL so it renders inline.
 */
// ALERT_EMOJI_GIF_URL as a custom inline emoji:
//   src: https://cdn.discordapp.com/attachments/1534458060721098846/1542464164105166899/alert_1.gif
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
const EMOJI_WHAT_HAPPENS = '<:placeholder:0>'; // TODO: replace with uploaded emoji code

// "Before you start" source image:
//   https://cdn.discordapp.com/attachments/1534458060721098846/1542508228175204382/stop.PNG
const EMOJI_BEFORE_YOU_START = '<:beforeyoustart:1542514313384956016>'; // uploaded emoji code

const PANEL_COLOR = '#8B0000';

// Plain text / markdown section divider (NOT the animated GIF).
const SECTION_DIVIDER = '──────────────────────';
module.exports = {
    data: new SlashCommandBuilder()
        .setName('backuppanel')
        .setDescription('Post the raid/backup request info panel with action buttons.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
        // Embed 0 — Top banner (image only, no title/text)
        const bannerEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setImage(BANNER_GIF_URL);

        // Embed 1 — Full panel content (single markdown description, plain dividers)
        const panelEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setDescription(
                '> Welcome to the backup panel. This is where the server calls for help, mobilizes against raiders, or organizes a strike of its own. Built to keep response fast and coordination clean.\n' +
                `\n${SECTION_DIVIDER}\n` +
                `\n**${EMOJI_WHAT_IS_THIS} What is this**\n` +
                '> This panel exists for three situations: you\'re currently getting teamed on and need numbers fast, an enemy clan has started raiding your server or territory, or your own clan wants to organize and launch a raid on someone else. One button, and the call goes out.\n' +
                `\n${SECTION_DIVIDER}\n` +
                `\n**${EMOJI_RULES} Rules**\n` +
                '> No spamming requests — one active call at a time per user. No false raid calls or crying wolf to pull people away from what they\'re doing. Repeated misuse results in a warning, then a ban from using this system entirely.\n' +
                `\n${SECTION_DIVIDER}\n` +
                `\n**${EMOJI_WHAT_HAPPENS} What happens when you request**\n` +
                '> The moment you press request, the bot instantly generates the live Roblox server link. If your Roblox account is already linked, your username is auto-filled into the call so responders know exactly who\'s asking and where to land.'
            )
            .setImage(SHIMMER_DIVIDER_URL);

        // Embed 2 — Before you start (its own embed so the shimmer appears
        // after this section as well as after the previous one).
        const beforeStartEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setDescription(
                `**${EMOJI_BEFORE_YOU_START} Before you start**\n` +
                '> You need to link your Roblox account once before this system will work for you. It\'s a one-time setup — after that, every future call auto-fills your info with zero extra steps.'
            )
            .setImage(SHIMMER_DIVIDER_URL);

        // Embed 3 — Request backup call-to-action (no trailing image; the button
        // in the action row below follows immediately with no visual gap).
        const ctaEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setDescription(
                `${ALERT_EMOJI} Request backup by clicking the button below.`
            );

        // Action row with the panel buttons — request_backup first since it is
        // the direct action of the call-to-action embed above.
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

        await interaction.reply({
            embeds: [
                bannerEmbed,
                panelEmbed,
                beforeStartEmbed,
                ctaEmbed
            ],
            components: [buttonRow]
        });
    }
};