'use strict';

const {
    SlashCommandBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ThumbnailBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder
} = require('discord.js');

// Native Components V2 flag (IS_COMPONENTS_V2) — required for Separator /
// Section / Thumbnail / MediaGallery components. V2 messages render FULL
// WIDTH (much wider than a classic embed) and disable content + embeds.
const RWINNER_V2_FLAGS = 1 << 15;

// Accent color matched to Discord's dark chat background (#2b2d31) so the
// Container's left accent bar is effectively invisible.
const RESULTS_NEUTRAL_COLOR = 0x2B2D31;

// Top banner image (hosted on catbox.moe — permanent, hotlinkable URL;
// Discord components cannot reference local files). Rendered FIRST in the
// Container so it sits at the TOP of the card, edge-to-edge full width.
const BANNER_IMAGE = 'https://files.catbox.moe/iyqyrd.gif';

// Fake MVP profile picture — rendered as a Thumbnail accessory on the RIGHT
// side of the MVP section (hosted on catbox.moe, hotlinkable).
const MVP_PFP_URL = 'https://files.catbox.moe/iyqyrd.gif';

// Big-dot unicode bullet placed before every labeled INFO line
// (U+25CF BLACK CIRCLE). Change this ONE constant to restyle every line
// (e.g. '\u2022' for the small classic bullet, '\u2B25' for a diamond).
const DOT = '\u25CF';

// Custom Discord emojis (hosted on the Discord CDN). The <:name:id> markdown
// resolves by the numeric ID, so it renders INLINE at emoji size in V2 text:
//   - INFO_EMOJI → the ⓘ info icon before the INFO header
//   - MVP_EMOJI  → the golden MVP crown on the Raid MVP line
const INFO_EMOJI = '<:info:1543995035396218950>';
const MVP_EMOJI = '<:mvp:1543994867552882699>';

// Fake raid-proof links. They are ONLY rendered as clickable text links in
// the Info text — they must NEVER be attached as media/gallery items, so
// Discord does not auto-display them inline.
const FAKE_PROOF_URLS = [
    'https://media.giphy.com/media/3o7qE1YN7aYDCHGGSk/giphy.gif',
    'https://media.giphy.com/media/26gscSgANaMfAagU0/giphy.gif',
    'https://media.giphy.com/media/13Y6LAwZuTGsgI/giphy.gif'
];

// Fake helper roster — one entry per helper, each separated by a native
// Separator (type 14) divider component.
const FAKE_HELPERS = [
    { name: '@HelperOne', duration: '24m 18s' },
    { name: '@HelperTwo', duration: '19m 42s' },
    { name: '@HelperThree', duration: '12m 05s' },
    { name: '@HelperFour', duration: '08m 31s' }
];

// Runtime newline used while composing TextDisplay content (avoids escape
// sequence mangling in the source file itself).
const NL = String.fromCharCode(10);

/**
 * Builds the "RAID WON" result card (native Components V2 — full width):
 *   - banner MediaGallery rendered FIRST → image sits at the TOP, edge-to-edge
 *   - neutral #2b2d31 Container accent → no visible colored accent bar
 *   - merged "📋 INFO" text blocks (everything except the roster), with the
 *     MVP block as a Section carrying a fake profile-picture Thumbnail on the
 *     RIGHT side
 *   - a "🛡️ HELPERS" section with a native Separator divider between EVERY
 *     helper line
 *   - "Kakuzu Raid Network · Raid #<id> · Result submitted by @<submitter>" footer
 * Raid proof is rendered as plain clickable text links ([Image 1](url) • ...)
 * so the screenshots do NOT auto-display inside the card.
 */
function buildResultsPayload() {
    const text = function (content) {
        return new TextDisplayBuilder().setContent(content).toJSON(); // type 10
    };
    const separator = function () {
        return new SeparatorBuilder() // type 14
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small)
            .toJSON();
    };

    const container = new ContainerBuilder().setAccentColor(RESULTS_NEUTRAL_COLOR).toJSON();
    container.size = 'large';

    const contents = [];

    // --- TOP banner: MediaGallery images render edge-to-edge across the full
    // card width and sit ABOVE everything else in the container ---
    contents.push(new MediaGalleryBuilder().addItems([
        new MediaGalleryItemBuilder()
            .setURL(BANNER_IMAGE)
            .setDescription('Victory banner')
            .toJSON()
    ]).toJSON());
    contents.push(separator());

    // --- ONE consolidated Info block (everything except Helpers) ---
    const proofLinks = FAKE_PROOF_URLS
        .map(function (url, index) {
            return '[Image ' + (index + 1) + '](' + url + ')';
        })
        .join(' • ');

    contents.push(text(
        '## 🏆 RAID WON — #421' + NL +
        NL +
        '### ' + INFO_EMOJI + ' INFO' + NL +
        DOT + ' **Requested By:** **@Requester**' + NL +
        DOT + ' **Ended By:** **@RaidEnder**' + NL +
        DOT + ' **Raid Duration:** `24m 18s`' + NL +
        NL +
        // Ender's Note rendered as a FULL quote block (both the label and the
        // note text sit behind quote bars); all other content stays unquoted.
        '> 📝 **Ender\u2019s Note**' + NL +
        '> They called more people, but we still destroyed them.'
    ));
    contents.push(separator());

    // --- MVP section: fake profile picture as a Thumbnail accessory pinned
    // to the RIGHT side of the section (the only right-side media a V2 card
    // supports). The Roblox name itself is the profile link. ---
    contents.push(
        new SectionBuilder()
            .setThumbnailAccessory(
                new ThumbnailBuilder()
                    .setURL(MVP_PFP_URL)
                    .setDescription('MVP profile picture')
            )
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                DOT + ' ' + MVP_EMOJI + ' **Raid MVP:** **@MVP**' + NL +
                DOT + ' **Roblox:** [DisplayName (@RobloxUsername)](https://www.roblox.com/users/1/profile)' + NL +
                DOT + ' **Discord:** **@MVP**'
            ))
            .toJSON()
    );
    contents.push(separator());

    contents.push(text(
        DOT + ' **Enemy Clan:** `Lucent`' + NL +
        DOT + ' **Enemies — 3:** `enemy_one` • `enemy_two` • `enemy_three`' + NL +
        NL +
        DOT + ' **Game:** The Strongest Battlegrounds' + NL +
        DOT + ' **Location:** `ASIA • India`' + NL +
        DOT + ' **Started:** 30 August 2026 at 16:58' + NL +
        DOT + ' **Ended:** 30 August 2026 at 17:22' + NL +
        NL +
        DOT + ' **Raid Proof:** ' + proofLinks
    ));
    contents.push(separator());

    // --- Helpers section: each helper in its own TextDisplay with a native
    // Separator divider between helpers ---
    contents.push(text('### 🛡️ HELPERS'));
    FAKE_HELPERS.forEach(function (helper, index) {
        contents.push(text('**' + helper.name + '** — `' + helper.duration + '`'));
        if (index < FAKE_HELPERS.length - 1) {
            contents.push(separator());
        }
    });

    // --- Subtext footer ---
    contents.push(separator());
    contents.push(text('-# Kakuzu Raid Network · Raid #421 · Result submitted by **@RaidEnder**'));

    container.components = contents;

    return {
        flags: RWINNER_V2_FLAGS,
        components: [container]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rwinner')
        .setDescription('Post the raid results card (MVP, helpers, enemies, proof).'),
    buildResultsPayload,
    async execute(interaction) {
        const payload = buildResultsPayload();
        await interaction.channel.send(payload).catch(err => console.error('rwinner: failed to post results card:', err));
        await interaction.reply({ content: '✅ Results card posted.', flags: 64 }).catch(() => null);
    }
};
