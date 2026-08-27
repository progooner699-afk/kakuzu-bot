const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

/*
 * These CDN links contain expiring query params (ex, is, hm) which are
 * intentionally stripped — Discord serves the file fine without them for
 * embed purposes. If the GIFs ever stop loading, they must be re-uploaded
 * and these base URLs refreshed.
 */
const BANNER_GIF_URL = 'https://cdn.discordapp.com/attachments/1534458060721098846/1542450307273850890/tenor_12.gif';
const SHIMMER_DIVIDER_URL = 'https://cdn.discordapp.com/attachments/1534458060721098846/1542450341445107762/shimmer_divider_red.gif';

const PANEL_COLOR = '#8B0000';

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

        // Embed 1 — Welcome / intro
        const welcomeEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setTitle('Backup Terminal')
            .setDescription('Welcome to the backup panel. Call for help or request a raid straight from here.')
            .setImage(SHIMMER_DIVIDER_URL);

        // Embed 2 — What is this
        const whatEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setDescription(
                '**What is this**\n' +
                '> Use this panel if you\'re getting teamed on, an enemy clan is raiding you, or you want to call a raid on a clan that\'s in this server.'
            )
            .setImage(SHIMMER_DIVIDER_URL);

        // Embed 3 — Rules
        const rulesEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setDescription(
                '**Rules**\n' +
                '> No spamming requests. No false raid calls. Misuse may lead to a ban from this system.'
            )
            .setImage(SHIMMER_DIVIDER_URL);

        // Embed 4 — What happens when you request
        const whatHappensEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setDescription(
                '**What happens when you request**\n' +
                '> The bot generates the Roblox server link automatically. If your Roblox account is linked, your Roblox name is auto-filled — no need to type anything.'
            )
            .setImage(SHIMMER_DIVIDER_URL);

        // Embed 5 — Before you start
        const beforeStartEmbed = new EmbedBuilder()
            .setColor(PANEL_COLOR)
            .setDescription(
                '**Before you start**\n' +
                '> You must link your Roblox account once before you can call a raid or request backup.'
            )
            .setImage(SHIMMER_DIVIDER_URL)
            .setFooter({ text: 'Backup Terminal' });

        // Action row with the panel buttons
        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('link_roblox')
                .setLabel('Link Roblox account')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('request_backup')
                .setLabel('Request backup')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🚨')
        );

        await interaction.reply({
            embeds: [
                bannerEmbed,
                welcomeEmbed,
                whatEmbed,
                rulesEmbed,
                whatHappensEmbed,
                beforeStartEmbed
            ],
            components: [buttonRow]
        });
    }
};