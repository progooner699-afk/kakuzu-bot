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
// Section / Thumbnail / MediaGallery components and disables content + embeds,
// so the whole card renders as components inside one Container.
const RWINNER_V2_FLAGS = 1 << 15;

// Accent color bar (green — the raid was WON).
const RESULTS_ACCENT_COLOR = 0x57F287;

// Fake showcase GIFs (verified 200-OK hosted GIFs). Swap for real media later.
const FAKE_MVP_THUMBNAIL_GIF = 'https://media.giphy.com/media/l0HlvtIPzPdt2usKs/giphy.gif';
const FAKE_PROOF_GIFS = [
    'https://media.giphy.com/media/3o7qE1YN7aYDCHGGSk/giphy.gif',
    'https://media.giphy.com/media/26gscSgANaMfAagU0/giphy.gif',
    'https://media.giphy.com/media/13Y6LAwZuTGsgI/giphy.gif'
];

// Runtime newline used while composing TextDisplay content (avoids escape
// sequence mangling in the source file itself).
const NL = String.fromCharCode(10);

/**
 * Builds the "RAID WON" result card (Components V2):
 * header (result / requester / ender / duration / ender's note), MVP section
 * with thumbnail accessory, enemy info, backup report, raid details, raid
 * proof media gallery, and a subtext footer — all separated by native
 * Separator (type 14) components.
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

    const container = new ContainerBuilder().setAccentColor(RESULTS_ACCENT_COLOR).toJSON();
    container.size = 'large';

    const contents = [];

    // --- Header: result, requester, ender, duration, ender's note ---
    contents.push(text(
        '### 🏆 RAID WON — #421' + NL +
        '**Result:** 🟢 `WON`' + NL +
        '**Requested By:** **@Requester**' + NL +
        '**Ended By:** **@RaidEnder**' + NL +
        '**Raid Duration:** `24m 18s`' + NL +
        NL +
        '> 📝 **Ender’s Note**' + NL +
        '> They called more people, but we still destroyed them.'
    ));
    contents.push(separator());

    // --- MVP section (fake MVP PFP thumbnail accessory on the right) ---
    contents.push(
        new SectionBuilder()
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(FAKE_MVP_THUMBNAIL_GIF))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '### 👑 RAID MVP' + NL +
                NL +
                '**Roblox:** DisplayName `(@RobloxUsername)`' + NL +
                '**Discord:** **@MVP**' + NL +
                '**Profile:** [View Roblox Profile](https://www.roblox.com/users/1/profile)'
            ))
            .toJSON()
    );
    contents.push(separator());

    // --- Enemy information ---
    contents.push(text(
        '### ⚔️ ENEMY INFORMATION' + NL +
        NL +
        '**Enemy Clan:** `Lucent`' + NL +
        '**Enemies — 3:**' + NL +
        '`enemy_one` • `enemy_two` • `enemy_three`'
    ));
    contents.push(separator());

    // --- Backup report ---
    contents.push(text(
        '### 🛡️ BACKUP REPORT — 4 HELPERS' + NL +
        NL +
        '**@HelperOne** — `24m 18s`' + NL +
        '**@HelperTwo** — `19m 42s`' + NL +
        '**@HelperThree** — `12m 05s`' + NL +
        '**@HelperFour** — `08m 31s`'
    ));
    contents.push(separator());

    // --- Raid details ---
    contents.push(text(
        '### 📍 RAID DETAILS' + NL +
        NL +
        '**Game:** The Strongest Battlegrounds' + NL +
        '**Location:** `ASIA • India`' + NL +
        '**Started:** 30 August 2026 at 16:58' + NL +
        '**Ended:** 30 August 2026 at 17:22'
    ));
    contents.push(separator());

    // --- Raid proof (fake media gallery) ---
    contents.push(text('### 📸 RAID PROOF — 3 IMAGES'));
    contents.push(new MediaGalleryBuilder().addItems(
        FAKE_PROOF_GIFS.map(function (url) {
            return new MediaGalleryItemBuilder().setURL(url).toJSON();
        })
    ).toJSON());

    // --- Subtext footer ---
    contents.push(text('-# Kakuzu Raid Network • Raid #421 • Result submitted by **@RaidEnder**'));

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
