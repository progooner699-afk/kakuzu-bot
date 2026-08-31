'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// Neutral embed color that exactly matches Discord's dark chat background
// (#2b2d31) — with no contrast against the message surface, the colored
// accent bar on the left edge of the embed is invisible.
const RESULTS_NEUTRAL_COLOR = 0x2B2D31;

// Top banner image (hosted on catbox.moe — permanent, hotlinkable URL;
// Discord embeds cannot reference local files).
const BANNER_IMAGE = 'https://files.catbox.moe/iyqyrd.gif';

// Fake raid-proof links. They are ONLY rendered as clickable text links in
// the Info field — they must NEVER be attached as embed images/media, so
// Discord does not auto-display them inline.
const FAKE_PROOF_URLS = [
    'https://media.giphy.com/media/3o7qE1YN7aYDCHGGSk/giphy.gif',
    'https://media.giphy.com/media/26gscSgANaMfAagU0/giphy.gif',
    'https://media.giphy.com/media/13Y6LAwZuTGsgI/giphy.gif'
];

// Runtime newline used while composing field values (avoids escape sequence
// mangling in the source file itself).
const NL = String.fromCharCode(10);

// Field values are hard-capped at 1024 chars by Discord — trim defensively.
function clampFieldValue(value) {
    return value.length > 1024 ? value.slice(0, 1020) + '…' : value;
}

/**
 * Builds the "RAID WON" result embed (classic embed, NOT Components V2):
 *   - neutral #2b2d31 color → no colored accent bar on the left edge
 *   - large banner image at the top (embed `image`)
 *   - ONE merged "📋 Info" field holding everything except the helper roster
 *   - a separate "🛡️ Helpers" field (one "@name — duration" per line)
 *   - "Kakuzu Raid Network · Raid #<id> · Result submitted by @<submitter>" footer
 * Raid proof is rendered as plain clickable text links ([Image 1](url) • ...)
 * so the screenshots do NOT auto-display inside the embed.
 */
function buildResultsPayload() {
    // --- Raid proof: text links only, never auto-displayed ---
    const proofLinks = FAKE_PROOF_URLS
        .map((url, index) => '[Image ' + (index + 1) + '](' + url + ')')
        .join(' • ');

    // --- ONE consolidated Info field (everything except Helpers) ---
    const infoValue = [
        '**Requested By:** **@Requester**' + NL +
        '**Ended By:** **@RaidEnder**' + NL +
        '**Raid Duration:** `24m 18s`' + NL +
        "**Ender's Note:** They called more people, but we still destroyed them.",
        NL +
        '**Raid MVP:** **@MVP**' + NL +
        // The Roblox name itself is the profile link — tapping it opens the
        // player's Roblox profile.
        '**Roblox:** [DisplayName (@RobloxUsername)](https://www.roblox.com/users/1/profile)' + NL +
        '**Discord:** **@MVP**',
        NL +
        '**Enemy Clan:** `Lucent`' + NL +
        '**Enemies — 3:** `enemy_one` • `enemy_two` • `enemy_three`',
        NL +
        '**Game:** The Strongest Battlegrounds' + NL +
        '**Location:** `ASIA • India`' + NL +
        '**Started:** 30 August 2026 at 16:58' + NL +
        '**Ended:** 30 August 2026 at 17:22',
        NL +
        '**Raid Proof:** ' + proofLinks
    ].join(NL);

    // --- Separate Helpers field: one "@username — duration" per line ---
    const helpersValue = [
        '**@HelperOne** — `24m 18s`',
        '**@HelperTwo** — `19m 42s`',
        '**@HelperThree** — `12m 05s`',
        '**@HelperFour** — `08m 31s`'
    ].join(NL);

    const embed = new EmbedBuilder()
        .setColor(RESULTS_NEUTRAL_COLOR)
        .setTitle('🏆 RAID WON — #421')
        .setImage(BANNER_IMAGE)
        .addFields([
            { name: '📋 Info', value: clampFieldValue(infoValue) },
            { name: '🛡️ Helpers', value: clampFieldValue(helpersValue) }
        ])
        .setFooter({ text: 'Kakuzu Raid Network · Raid #421 · Result submitted by @RaidEnder' });

    return { embeds: [embed] };
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
