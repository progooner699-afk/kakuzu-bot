'use strict';

/*
 * /announcement — interactive Components V2 announcement builder.
 *
 * Flow:
 *   1. /announcement opens an EPHEMERAL V2 builder panel with buttons:
 *      Title, Description, Thumbnail, Webhook Icon, Color, Ping, Webhook name,
 *      Field 1-8, Clear Fields, Preview, Publish, Cancel.
 *   2. Every button (except Thumbnail / Icon / Preview / Publish / Cancel)
 *      opens a modal; the collected values are stored in a per-user session.
 *   3. Thumbnail + Icon open UPLOAD COLLECTORS: the user sends one image (or a
 *      pasted URL) in the channel within 2 minutes. Thumbnail renders as a WIDE
 *      full-width MediaGallery banner at the TOP of the card; Icon becomes the
 *      webhook profile picture (avatar) — if no icon is chosen, an invisible
 *      transparent avatar is applied so the grey default icon is not shown.
 *   4. Color (hex, e.g. #5865F2) drives the Container accent bar — the vertical
 *      "embed line" on the left of the card and the preview.
 *   5. Every field section is separated by a native V2 Separator (type 14).
 *   6. Publish asks for a target channel (channel-select), then posts the
 *      final V2 card THROUGH A WEBHOOK whose name the user typed — the ping
 *      (if any) is sent as a separate message first, because the V2 flag
 *      disables message `content`.
 */

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
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder
} = require('discord.js');

const path = require('path');
const fs = require('fs');

// Message flag required to enable native Components V2 (Separator etc).
// NOTE: with this flag Discord DISABLES content + embeds on the message.
const ANNOUNCEMENT_V2_FLAGS = 1 << 15;
// Ephemeral message flag.
const EPHEMERAL_FLAG = 1 << 6;

// Accent color for the builder panel Container (Kakuzu red).
const PANEL_ACCENT_COLOR = 0x8B0000;
// Default accent color for the final announcement card Container (Blurple).
const ANNOUNCEMENT_ACCENT_COLOR = 0x5865F2;
// Default color shown when the user has not picked one (hex string).
const DEFAULT_ACCENT_COLOR = '#5865F2';

// Runtime newline used while composing TextDisplay content (avoids escape
// sequence mangling in the source file itself).
const NL = String.fromCharCode(10);

// Maximum number of custom fields on the announcement card.
const MAX_FIELDS = 8;
// How long the thumbnail/icon upload collectors wait for the user's image.
const UPLOAD_COLLECTOR_MS = 2 * 60 * 1000;
// Fallback webhook name when the user did not type one.
const DEFAULT_WEBHOOK_NAME = 'Announcements';
// Bundled 1x1 fully-transparent PNG — applied as the webhook avatar when the
// user does not pick an icon, so Discord's grey default icon stays invisible.
const INVISIBLE_AVATAR_FILE = path.join(__dirname, '..', 'assets', 'transparent-avatar.png');

// In-memory builder sessions, keyed by `${guildId}:${userId}`.
const sessions = new Map();

function sessionKey(interaction) {
    return interaction.guild.id + ':' + interaction.user.id;
}

function getSession(interaction) {
    return sessions.get(sessionKey(interaction)) || null;
}

function createSession(interaction) {
    const state = {
        title: '',
        description: '',
        fields: [],          // { name, value } — max MAX_FIELDS
        thumbnailUrl: null,  // wide top banner image
        webhookIconUrl: null,        // webhook avatar URL (status display)
        webhookIconBuffer: null,     // webhook avatar image bytes (Buffer)
        accentColor: DEFAULT_ACCENT_COLOR, // card "embed line" colour (hex string)
        ping: '',            // sent as a separate webhook message
        webhookName: '',     // webhook profile name typed by the user
        panelMessageId: null
    };
    sessions.set(sessionKey(interaction), state);
    return state;
}

/* ------------------------------------------------------------------ */
/* Payload builders                                                   */
/* ------------------------------------------------------------------ */

function text(content) {
    return new TextDisplayBuilder().setContent(content).toJSON(); // type 10
}

function separator() {
    return new SeparatorBuilder() // type 14
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small)
        .toJSON();
}

/**
 * Resolves the chosen accent colour (hex string like `#5865F2`) into the
 * integer Discord.js expects for the Container accent bar. Falls back to the
 * default blurple when missing / invalid.
 */
function resolveAccentColor(state) {
    const raw = (state && state.accentColor) ? String(state.accentColor).trim() : '';
    const hex = raw.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
    return ANNOUNCEMENT_ACCENT_COLOR;
}

/**
 * Builds the FINAL announcement card as a native Components V2 payload:
 * optional wide top banner (MediaGallery), title, description, every custom
 * field — each section separated by a native V2 separator — and a footer.
 */
function buildAnnouncementPayload(state) {
    const container = new ContainerBuilder().setAccentColor(resolveAccentColor(state)).toJSON();
    container.size = 'large';

    const contents = [];

    // --- WIDE TOP BANNER (edge-to-edge MediaGallery, type 12) ---
    if (state.thumbnailUrl) {
        contents.push(new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(state.thumbnailUrl)
        ).toJSON());
    }

    // --- Title ---
    contents.push(text('# 📢 ' + (state.title || 'Announcement')));
    contents.push(separator());

    // --- Description ---
    if (state.description) {
        contents.push(text(state.description));
        contents.push(separator());
    }

    // --- Custom fields (up to 8), each followed by a V2 separator ---
    (state.fields || []).forEach(function (field) {
        contents.push(text('### ' + field.name + NL + NL + field.value));
        contents.push(separator());
    });

    // --- Footer ---
    contents.push(text('-# ✦ Announced <t:' + Math.floor(Date.now() / 1000) + ':F>'));

    container.components = contents;

    return { flags: ANNOUNCEMENT_V2_FLAGS, components: [container] };
}

function fieldButton(n) {
    return new ButtonBuilder()
        .setCustomId('annb_field_' + n)
        .setLabel('Field ' + n)
        .setStyle(ButtonStyle.Secondary);
}

/**
 * Builds the ephemeral V2 BUILDER PANEL (status text + button rows).
 */
function buildBuilderComponents(state) {
    const container = new ContainerBuilder().setAccentColor(PANEL_ACCENT_COLOR).toJSON();
    container.size = 'large';

    const filledCount = (state.fields || []).length;
    const fieldList = filledCount
        ? state.fields.map(function (f, i) {
              const shortValue = (f.value || '').length > 60 ? f.value.slice(0, 60) + '…' : (f.value || '—');
              return '> **' + (i + 1) + '. ' + (f.name || 'Field') + '** — ' + shortValue;
          }).join(NL)
        : '> • No fields yet — add up to **' + MAX_FIELDS + '** below.';

    const statusLines = [
        '# 🛠️ ANNOUNCEMENT BUILDER',
        '',
        '> **Title:** ' + (state.title ? '✅ ' + (state.title.length > 40 ? state.title.slice(0, 40) + '…' : state.title) : '❌ not set'),
        '> **Description:** ' + (state.description ? '✅ set (' + state.description.length + ' chars)' : '❌ not set'),
        '> **Fields:** `' + filledCount + ' / ' + MAX_FIELDS + '`',
        '> **Thumbnail (wide top banner):** ' + (state.thumbnailUrl ? '✅ uploaded' : '❌ not set'),
        '> **Webhook icon:** ' + (state.webhookIconUrl ? '✅ custom' : '— invisible (transparent)'),
        '> **Embed line color:** `' + resolveAccentColor(state).toString(16).padStart(6, '0').toUpperCase() + '`',
        '> **Ping:** ' + (state.ping ? '`' + state.ping + '`' : '—'),
        '> **Webhook name:** `' + (state.webhookName || DEFAULT_WEBHOOK_NAME) + '`',
        '',
        '**FIELDS**',
        fieldList
    ];

    const contents = [text(statusLines.join(NL)), separator()];

    // Field rows: Field 1-5, then Field 6-8 + Clear Fields.
    contents.push(new ActionRowBuilder().addComponents(
        fieldButton(1), fieldButton(2), fieldButton(3), fieldButton(4), fieldButton(5)
    ).toJSON());
    contents.push(new ActionRowBuilder().addComponents(
        fieldButton(6), fieldButton(7), fieldButton(8),
        new ButtonBuilder().setCustomId('annb_clearfields').setLabel('🗑️ Clear Fields').setStyle(ButtonStyle.Danger)
    ).toJSON());
    contents.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('annb_title').setLabel('📝 Title').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('annb_desc').setLabel('📄 Description').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('annb_thumb').setLabel('🖼️ Thumbnail').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('annb_icon').setLabel('🪝 Icon').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('annb_color').setLabel('🎨 Color').setStyle(ButtonStyle.Secondary)
    ).toJSON());
    contents.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('annb_ping').setLabel('🔔 Ping').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('annb_webhook').setLabel('🪝 Webhook Name').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('annb_preview').setLabel('👁️ Preview').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('annb_publish').setLabel('🚀 Publish').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('annb_cancel').setLabel('✖️ Cancel').setStyle(ButtonStyle.Danger)
    ).toJSON());

    container.components = contents;

    return { flags: ANNOUNCEMENT_V2_FLAGS, components: [container] };
}

/* ------------------------------------------------------------------ */
/* Modal builders                                                     */
/* ------------------------------------------------------------------ */

function openTitleModal(interaction, state) {
    const input = new TextInputBuilder()
        .setCustomId('annb_title_input')
        .setLabel('Announcement Title')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter the announcement title…')
        .setRequired(true)
        .setMaxLength(256);
    if (state.title) input.setValue(state.title);

    const modal = new ModalBuilder().setCustomId('annb_titlemodal').setTitle('📝 Announcement Title');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
}

function openDescriptionModal(interaction, state) {
    const input = new TextInputBuilder()
        .setCustomId('annb_desc_input')
        .setLabel('Description (Full Content)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Enter the full announcement content…')
        .setRequired(true)
        .setMaxLength(4000);
    if (state.description) input.setValue(state.description);

    const modal = new ModalBuilder().setCustomId('annb_descmodal').setTitle('📄 Announcement Description');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
}

function openFieldModal(interaction, state, index) {
    const existing = state.fields[index - 1] || null;

    const nameInput = new TextInputBuilder()
        .setCustomId('annb_field_name')
        .setLabel('Field ' + index + ' Name (blank = remove)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Rules, Rewards, Schedule…')
        .setRequired(false)
        .setMaxLength(256);
    const valueInput = new TextInputBuilder()
        .setCustomId('annb_field_value')
        .setLabel('Field ' + index + ' Content')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Enter the content for this field…')
        .setRequired(false)
        .setMaxLength(1024);
    if (existing) {
        nameInput.setValue(existing.name);
        valueInput.setValue(existing.value);
    }

    const modal = new ModalBuilder()
        .setCustomId('annb_fieldmodal_' + index)
        .setTitle('Field ' + index + ' of ' + MAX_FIELDS);
    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(valueInput)
    );
    return interaction.showModal(modal);
}

function openPingModal(interaction, state) {
    const input = new TextInputBuilder()
        .setCustomId('annb_ping_input')
        .setLabel('Ping (@everyone / @here / role mention)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. @everyone, @here or <@&ROLE_ID> (blank = none)')
        .setRequired(false)
        .setMaxLength(256);
    if (state.ping) input.setValue(state.ping);

    const modal = new ModalBuilder().setCustomId('annb_pingmodal').setTitle('🔔 Announcement Ping');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
}

function openWebhookModal(interaction, state) {
    const input = new TextInputBuilder()
        .setCustomId('annb_webhook_input')
        .setLabel('Webhook Name (sender profile)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Kakuzu News — the message shows this name')
        .setRequired(false)
        .setMaxLength(80);
    if (state.webhookName) input.setValue(state.webhookName);

    const modal = new ModalBuilder().setCustomId('annb_webhookmodal').setTitle('🪝 Webhook Name');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
}

function openColorModal(interaction, state) {
    const input = new TextInputBuilder()
        .setCustomId('annb_color_input')
        .setLabel('Embed Line Color (hex)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. #5865F2, #ED4245, #FEE75C')
        .setRequired(false)
        .setMaxLength(9);
    if (state.accentColor) input.setValue('#' + resolveAccentColor(state).toString(16).padStart(6, '0').toUpperCase());

    const modal = new ModalBuilder().setCustomId('annb_colormodal').setTitle('🎨 Embed Line Color');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

async function refreshPanel(interaction, state) {
    if (!state || !state.panelMessageId || !interaction.channel) return;
    const msg = await interaction.channel.messages.fetch(state.panelMessageId).catch(() => null);
    if (msg) {
        await msg.edit(buildBuilderComponents(state)).catch(() => null);
    }
}

function buildAllowedMentions(pingText) {
    const allowedMentions = { parse: [] };
    if (/@everyone|@here/i.test(pingText)) allowedMentions.parse.push('everyone');
    const roleIds = [];
    const re = /<@&(\d+)>/g;
    let m;
    while ((m = re.exec(pingText)) !== null) roleIds.push(m[1]);
    if (roleIds.length) allowedMentions.roles = [...new Set(roleIds)];
    return allowedMentions;
}

/**
 * Reads the bundled fully-transparent PNG used as the "invisible" webhook
 * avatar (so Discord's grey default icon is not shown when no icon is chosen).
 * Returns null if the asset is somehow missing (Discord will then use its
 * default grey icon as a last resort).
 */
function getInvisibleAvatarBuffer() {
    try {
        if (fs.existsSync(INVISIBLE_AVATAR_FILE)) {
            return fs.readFileSync(INVISIBLE_AVATAR_FILE);
        }
    } catch (err) {
        console.warn('[announcement] transparent avatar read failed:', (err && err.message) || err);
    }
    return null;
}

/**
 * Fetches the bytes of a remote image URL (used for a pasted webhook icon URL).
 * Falls back to the attachment URL when the fetch fails.
 */
async function bufferFromUrl(url) {
    if (!/^https?:\/\/\S+$/i.test(String(url || ''))) return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        if (!arr || !arr.byteLength) return null;
        return Buffer.from(arr);
    } catch (err) {
        console.warn('[announcement] icon fetch failed:', (err && err.message) || err);
        return null;
    }
}
 /**
 * Runs the thumbnail UPLOAD COLLECTOR. The user sends one message in the
 * current channel within 2 minutes; the first image attachment (or a raw
 * URL) becomes the wide top banner. Typing `remove` clears it.
 */
async function startThumbnailCollector(interaction, state) {
    await interaction.reply({
        content: '🖼️ **Thumbnail upload:** send **one image** in this channel now' + NL +
            '(or paste an image URL as a message).' + NL +
            '> Type `remove` to clear the current thumbnail. You have **2 minutes**.',
        flags: EPHEMERAL_FLAG
    }).catch(() => null);

    if (!interaction.channel || typeof interaction.channel.createMessageCollector !== 'function') return;

    const collector = interaction.channel.createMessageCollector({
        filter: function (m) { return m.author.id === interaction.user.id; },
        time: UPLOAD_COLLECTOR_MS,
        max: 1
    });

    collector.on('collect', async function (msg) {
        const content = (msg.content || '').trim();
        let url = null;

        const image = msg.attachments.find(function (a) {
            return a.contentType && a.contentType.startsWith('image/');
        });
        if (image) {
            url = image.url;
        } else if (/^https?:\/\/\S+$/i.test(content)) {
            url = content;
        } else if (/^remove$/i.test(content)) {
            state.thumbnailUrl = null;
            await interaction.followUp({ content: '🗑️ Thumbnail cleared.', flags: EPHEMERAL_FLAG }).catch(() => null);
            await refreshPanel(interaction, state);
            return;
        }

        if (!url) {
            await interaction.followUp({
                content: '❌ That was not an image or a valid URL. Press **🖼️ Thumbnail** on the builder panel to try again.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            return;
        }

        state.thumbnailUrl = url;
        await interaction.followUp({
            content: '✅ Thumbnail set — it will render as the wide top banner of the card.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        await refreshPanel(interaction, state);
    });

    collector.on('end', async function (collected) {
        if (collected.size === 0) {
            await interaction.followUp({
                content: '⌛ Thumbnail upload window expired — nothing was collected. Press **🖼️ Thumbnail** to try again.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
        }
    });
}

/**
 * Runs the webhook-ICON upload collector. The user sends one message in the
 * current channel within 2 minutes; the first image attachment (or a pasted
 * URL) is stored as the webhook profile picture (avatar). Typing `remove`
 * clears it and falls back to the invisible transparent avatar on publish.
 */
async function startWebhookIconCollector(interaction, state) {
    await interaction.reply({
        content: '🪝 **Webhook icon upload:** send **one image** in this channel now' + NL +
            '(or paste an image URL as a message).' + NL +
            '> Type `remove` to clear the icon (the grey avatar becomes invisible). You have **2 minutes**.',
        flags: EPHEMERAL_FLAG
    }).catch(() => null);

    if (!interaction.channel || typeof interaction.channel.createMessageCollector !== 'function') return;

    const collector = interaction.channel.createMessageCollector({
        filter: function (m) { return m.author.id === interaction.user.id; },
        time: UPLOAD_COLLECTOR_MS,
        max: 1
    });

    collector.on('collect', async function (msg) {
        const content = (msg.content || '').trim();
        let url = null;
        let buffer = null;

        const image = msg.attachments.find(function (a) {
            return a.contentType && a.contentType.startsWith('image/');
        });
        if (image) {
            url = image.url;
        } else if (/^https?:\/\/\S+$/i.test(content)) {
            url = content;
        } else if (/^remove$/i.test(content)) {
            state.webhookIconUrl = null;
            state.webhookIconBuffer = null;
            await interaction.followUp({
                content: '🗑️ Webhook icon cleared — a transparent (invisible) avatar will be used.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            await refreshPanel(interaction, state);
            return;
        }

        if (!url) {
            await interaction.followUp({
                content: '❌ That was not an image or a valid URL. Press **🪝 Icon** on the builder panel to try again.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            return;
        }

        buffer = await bufferFromUrl(url);
        if (!buffer) {
            await interaction.followUp({
                content: '❌ Could not download that image for the webhook avatar. Try a direct image URL or upload the file here.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
            return;
        }

        state.webhookIconUrl = url;
        state.webhookIconBuffer = buffer;
        await interaction.followUp({
            content: '✅ Webhook icon set — the announcement will be posted under this profile picture.',
            flags: EPHEMERAL_FLAG
        }).catch(() => null);
        await refreshPanel(interaction, state);
    });

    collector.on('end', async function (collected) {
        if (collected.size === 0) {
            await interaction.followUp({
                content: '⌛ Webhook icon upload window expired — nothing was collected. Press **🪝 Icon** to try again.',
                flags: EPHEMERAL_FLAG
            }).catch(() => null);
        }
    });
}

/**
 * Publish: validates the session, then asks for the target channel.
 */
async function startPublish(interaction, state) {
    if (!state.title || !state.description) {
        return interaction.reply({
            content: '❌ **Title** and **Description** are required before publishing.',
            flags: EPHEMERAL_FLAG
        });
    }

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('annb_channel')
        .setPlaceholder('Select the channel to publish the announcement in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    return interaction.reply({
        content: '📡 **Publish announcement**' + NL +
            '> Sender profile: `' + (state.webhookName || DEFAULT_WEBHOOK_NAME) + '`' + NL +
            '> Ping: ' + (state.ping ? '`' + state.ping + '`' : 'none') + NL +
            '> Pick the target channel below — the card is posted **through a webhook**' + NL +
            '> so it appears under that profile instead of the bot.',
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: EPHEMERAL_FLAG
    });
}

/**
 * Channel-select handler: find or create the webhook with the user's typed
 * name in the target channel, send the ping as a separate message, then post
 * the V2 announcement card through that webhook.
 */
async function publishToChannel(interaction, state) {
    const selectedChannel = interaction.channels.first();
    if (!selectedChannel) {
        return interaction.reply({ content: '❌ Please select a valid channel.', flags: EPHEMERAL_FLAG }).catch(() => null);
    }

    await interaction.deferReply({ flags: EPHEMERAL_FLAG }).catch(() => null);

    try {
        const targetChannel = await interaction.client.channels.fetch(selectedChannel.id);
        if (!targetChannel || !targetChannel.isTextBased()) {
            throw new Error('The selected channel is not a text channel.');
        }

        const webhookName = (state.webhookName || DEFAULT_WEBHOOK_NAME).trim() || DEFAULT_WEBHOOK_NAME;

        // Resolve the webhook avatar: the chosen icon (if any), else the bundled
        // fully-transparent PNG so Discord's grey default icon stays invisible.
        const avatarBuffer = state.webhookIconBuffer || getInvisibleAvatarBuffer() || undefined;

        // Find or create the webhook with the chosen name in the target channel.
        const webhooks = await targetChannel.fetchWebhooks();
        let webhook = webhooks.find(function (w) { return w.name === webhookName; });
        if (!webhook) {
            webhook = await targetChannel.createWebhook({
                name: webhookName,
                avatar: avatarBuffer,
                reason: 'Announcement webhook (created by ' + interaction.user.tag + ' via /announcement)'
            });
        } else if (avatarBuffer && typeof webhook.edit === 'function') {
            // Existing webhook — apply the chosen/invisible avatar so the
            // sender always shows the intended profile picture.
            await webhook.edit({ avatar: avatarBuffer }).catch(() => null);
        }

        // Ping first — the V2 flag disables message content on the card itself.
        if (state.ping) {
            await webhook.send({
                content: state.ping,
                username: webhookName,
                allowedMentions: buildAllowedMentions(state.ping)
            });
        }

        const payload = buildAnnouncementPayload(state);
        await webhook.send({
            flags: payload.flags,
            components: payload.components,
            username: webhookName
        });

        // Retire the builder panel and close the session.
        const panelMsg = state.panelMessageId && interaction.channel
            ? await interaction.channel.messages.fetch(state.panelMessageId).catch(() => null)
            : null;
        sessions.delete(sessionKey(interaction));

        const done = '✅ Announcement published in <#' + targetChannel.id + '> via the **' + webhookName + '** webhook.';
        if (panelMsg) {
            const retired = new EmbedBuilder()
                .setTitle('✅ Announcement Published')
                .setDescription(done)
                .setColor(0x57F287);
            await panelMsg.edit({ components: [], embeds: [retired] }).catch(() => null);
        }
        await interaction.editReply({ content: done }).catch(() => null);
    } catch (err) {
        console.error('[announcement] publish failed:', err);
        const errText = '❌ Failed to publish the announcement: `' +
            String((err && err.message) || err).slice(0, 300) + '`';
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: errText }).catch(() => null);
        } else {
            await interaction.reply({ content: errText, flags: EPHEMERAL_FLAG }).catch(() => null);
        }
    }
}

/* ------------------------------------------------------------------ */
/* Component dispatch (buttons + modals + channel select)             */
/* ------------------------------------------------------------------ */

function sessionExpiredReply(interaction) {
    return interaction.reply({
        content: '⌛ This announcement builder session has expired — run `/announcement` again.',
        flags: EPHEMERAL_FLAG
    }).catch(() => null);
}

/**
 * Handles every `annb_*` interaction. Returns true when the interaction was
 * handled (so the caller can stop processing). Never rethrows — errors are
 * reported to the user as an ephemeral message.
 */
async function handleAnnouncementComponent(interaction) {
    const customId = typeof interaction.customId === 'string' ? interaction.customId : '';
    if (!customId.startsWith('annb_')) return false;

    try {
        // ---- Channel select (publish) ----
        if (customId === 'annb_channel') {
            const state = getSession(interaction);
            if (!state) {
                sessionExpiredReply(interaction);
                return true;
            }
            await publishToChannel(interaction, state);
            return true;
        }

        const state = getSession(interaction);
        if (!state) {
            sessionExpiredReply(interaction);
            return true;
        }

        // ---- Buttons ----
        if (interaction.isButton()) {
            switch (customId) {
                case 'annb_title':
                    await openTitleModal(interaction, state);
                    return true;
                case 'annb_desc':
                    await openDescriptionModal(interaction, state);
                    return true;
                case 'annb_thumb':
                    await startThumbnailCollector(interaction, state);
                    return true;
                case 'annb_icon':
                    await startWebhookIconCollector(interaction, state);
                    return true;
                case 'annb_color':
                    await openColorModal(interaction, state);
                    return true;
                case 'annb_ping':
                    await openPingModal(interaction, state);
                    return true;
                case 'annb_webhook':
                    await openWebhookModal(interaction, state);
                    return true;
                case 'annb_clearfields':
                    state.fields = [];
                    await interaction.reply({ content: '🗑️ All fields cleared.', flags: EPHEMERAL_FLAG }).catch(() => null);
                    await refreshPanel(interaction, state);
                    return true;
                case 'annb_preview': {
                    if (!state.title || !state.description) {
                        await interaction.reply({
                            content: '❌ Set a **Title** and **Description** first.',
                            flags: EPHEMERAL_FLAG
                        }).catch(() => null);
                        return true;
                    }
                    const payload = buildAnnouncementPayload(state);
                    await interaction.reply({
                        flags: ANNOUNCEMENT_V2_FLAGS | EPHEMERAL_FLAG,
                        components: payload.components
                    });
                    return true;
                }
                case 'annb_publish':
                    await startPublish(interaction, state);
                    return true;
                case 'annb_cancel': {
                    sessions.delete(sessionKey(interaction));
                    const cancelled = new EmbedBuilder()
                        .setTitle('✖️ Announcement Builder Cancelled')
                        .setDescription('The draft was discarded. Run `/announcement` to start a new one.')
                        .setColor(0xED4245);
                    await interaction.update({ components: [], embeds: [cancelled] }).catch(() => null);
                    return true;
                }
                default:
                    // Field buttons: annb_field_<n>
                    if (customId.startsWith('annb_field_')) {
                        const index = parseInt(customId.replace('annb_field_', ''), 10);
                        if (index >= 1 && index <= MAX_FIELDS) {
                            await openFieldModal(interaction, state, index);
                            return true;
                        }
                    }
                    return false;
            }
        }

        // ---- Modals ----
        if (interaction.isModalSubmit()) {
            if (customId === 'annb_titlemodal') {
                state.title = interaction.fields.getTextInputValue('annb_title_input').trim();
                await interaction.reply({ content: '✅ Title saved.', flags: EPHEMERAL_FLAG }).catch(() => null);
                await refreshPanel(interaction, state);
                return true;
            }
            if (customId === 'annb_descmodal') {
                state.description = interaction.fields.getTextInputValue('annb_desc_input').trim();
                await interaction.reply({ content: '✅ Description saved.', flags: EPHEMERAL_FLAG }).catch(() => null);
                await refreshPanel(interaction, state);
                return true;
            }
            if (customId.startsWith('annb_fieldmodal_')) {
                const index = parseInt(customId.replace('annb_fieldmodal_', ''), 10);
                if (index < 1 || index > MAX_FIELDS) return true;
                let name = '';
                let value = '';
                try { name = interaction.fields.getTextInputValue('annb_field_name').trim(); } catch (e) { name = ''; }
                try { value = interaction.fields.getTextInputValue('annb_field_value').trim(); } catch (e) { value = ''; }

                if (!name) {
                    // Blank name = remove that field.
                    if (state.fields[index - 1]) state.fields.splice(index - 1, 1);
                    await interaction.reply({ content: '🗑️ Field ' + index + ' removed.', flags: EPHEMERAL_FLAG }).catch(() => null);
                } else {
                    state.fields[index - 1] = { name: name, value: value || '—' };
                    await interaction.reply({ content: '✅ Field ' + index + ' saved.', flags: EPHEMERAL_FLAG }).catch(() => null);
                }
                await refreshPanel(interaction, state);
                return true;
            }
            if (customId === 'annb_pingmodal') {
                let ping = '';
                try { ping = interaction.fields.getTextInputValue('annb_ping_input').trim(); } catch (e) { ping = ''; }
                state.ping = ping;
                await interaction.reply({
                    content: ping ? '✅ Ping saved: `' + ping + '`' : '🔔 Ping cleared.',
                    flags: EPHEMERAL_FLAG
                }).catch(() => null);
                await refreshPanel(interaction, state);
                return true;
            }
            if (customId === 'annb_webhookmodal') {
                let name = '';
                try { name = interaction.fields.getTextInputValue('annb_webhook_input').trim(); } catch (e) { name = ''; }
                state.webhookName = name;
                await interaction.reply({
                    content: '✅ Webhook name saved: `' + (name || DEFAULT_WEBHOOK_NAME) + '`',
                    flags: EPHEMERAL_FLAG
                }).catch(() => null);
                await refreshPanel(interaction, state);
                return true;
            }
            if (customId === 'annb_colormodal') {
                let raw = '';
                try { raw = interaction.fields.getTextInputValue('annb_color_input').trim(); } catch (e) { raw = ''; }
                const hex = String(raw).replace(/^#/, '').trim();
                if (!hex) {
                    state.accentColor = DEFAULT_ACCENT_COLOR;
                    await interaction.reply({
                        content: '🎨 Color reset to default `' + DEFAULT_ACCENT_COLOR + '`.',
                        flags: EPHEMERAL_FLAG
                    }).catch(() => null);
                } else if (/^[0-9a-fA-F]{6}$/.test(hex)) {
                    state.accentColor = '#' + hex.toUpperCase();
                    await interaction.reply({
                        content: '🎨 Embed line color set to `#' + hex.toUpperCase() + '`.',
                        flags: EPHEMERAL_FLAG
                    }).catch(() => null);
                } else {
                    await interaction.reply({
                        content: '❌ Invalid color — use a 6-digit hex like `#5865F2`.',
                        flags: EPHEMERAL_FLAG
                    }).catch(() => null);
                }
                await refreshPanel(interaction, state);
                return true;
            }
            return false;
        }

        return false;
    } catch (err) {
        console.error('[announcement] component handler error:', err);
        const errText = '❌ Announcement builder error: `' + String((err && err.message) || err).slice(0, 300) + '`';
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content: errText, flags: EPHEMERAL_FLAG });
            } else {
                await interaction.reply({ content: errText, flags: EPHEMERAL_FLAG });
            }
        } catch (e) { /* swallow — nothing more we can do */ }
        return true;
    }
}

/* ------------------------------------------------------------------ */
/* Command                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('announcement')
        .setDescription('Open the interactive announcement builder (V2 card, up to 8 fields, webhook sender).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    ANNOUNCEMENT_V2_FLAGS,
    MAX_FIELDS,
    DEFAULT_ACCENT_COLOR,
    getInvisibleAvatarBuffer,
    buildAnnouncementPayload,
    buildBuilderComponents,
    handleAnnouncementComponent,
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used inside a server.', flags: EPHEMERAL_FLAG });
        }
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
            return interaction.reply({
                content: 'You need the **Manage Messages** permission to use the announcement builder.',
                flags: EPHEMERAL_FLAG
            });
        }

        const state = createSession(interaction);
        const reply = await interaction.reply({
            flags: ANNOUNCEMENT_V2_FLAGS | EPHEMERAL_FLAG,
            components: buildBuilderComponents(state).components,
            fetchReply: true
        }).catch(async function (err) {
            // The server may not have Components V2 enabled for the bot — fall
            // back to a classic ephemeral embed panel with the same buttons.
            console.warn('[announcement] V2 panel send failed, using embed fallback:', (err && err.message) || err);
            const status =
                '**Title:** ' + (state.title ? '✅' : '❌') + NL +
                '**Description:** ' + (state.description ? '✅' : '❌') + NL +
                '**Fields:** `' + state.fields.length + ' / ' + MAX_FIELDS + '`' + NL +
                '**Thumbnail:** ' + (state.thumbnailUrl ? '✅' : '❌') + NL +
                '**Webhook icon:** ' + (state.webhookIconUrl ? '✅' : '— transparent') + NL +
                '**Embed line color:** `' + resolveAccentColor(state).toString(16).padStart(6, '0').toUpperCase() + '`' + NL +
                '**Ping:** ' + (state.ping || '—') + NL +
                '**Webhook name:** `' + (state.webhookName || DEFAULT_WEBHOOK_NAME) + '`';
            const embed = new EmbedBuilder()
                .setTitle('🛠️ Announcement Builder')
                .setDescription(status)
                .setColor(PANEL_ACCENT_COLOR);
            return interaction.reply({
                embeds: [embed],
                components: buildBuilderComponents(state).components.filter(function (c) { return c.type === 1; }),
                flags: EPHEMERAL_FLAG,
                fetchReply: true
            });
        });

        if (reply && reply.id) state.panelMessageId = reply.id;
    }
};






