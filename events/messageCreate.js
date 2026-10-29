'use strict';

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const raidStateManager = require('../handlers/raidStateManager');

const NAV_MESSAGE_INTERVAL = 20;
const RAID_ALERT_V2_FLAGS = 1 << 15;

// In-memory per-channel nav state: channelId -> { count, navMessageId }
const navState = new Map();

function clearNavState(channelId) {
    navState.delete(channelId);
}

function buildNavPayload(raid, guildId) {
    const channelId = raid.alertChannelId || raid.channelId;
    const messageId = raid.messageId;
    const url = (guildId && channelId && messageId)
        ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
        : null;

    const container = new ContainerBuilder().toJSON();
    container.size = 'large';
    const contents = [];
    contents.push(new TextDisplayBuilder().setContent('> 📢 **Looking to join this raid?**').toJSON());
    contents.push(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small).toJSON());
    contents.push(new TextDisplayBuilder().setContent('The original raid request is higher up. Click below to view the raid details and Help button.').toJSON());
    if (url) {
        contents.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🔎 View Raid Request').setURL(url)
        ).toJSON());
    }
    container.components = contents;
    return { flags: RAID_ALERT_V2_FLAGS, components: [container] };
}

module.exports = {
    name: 'messageCreate',
    once: false,
    async execute(message, client) {
        try {
            // Ignore bot messages to prevent spam loops.
            if (!message || !message.author || message.author.bot) return;
            if (!message.guild || !message.channel) return;

            const guildId = message.guild.id;
            const raids = raidStateManager.loadRaids(guildId);
            const raid = (raids && Array.isArray(raids.raids))
                ? raids.raids.find(r => r.alertChannelId === message.channel.id && r.status !== 'CLOSED')
                : null;
            if (!raid) {
                // Not an active raid channel (or raid closed) — drop any tracked state.
                clearNavState(message.channel.id);
                return;
            }

            // Track human message count for this channel.
            let state = navState.get(message.channel.id);
            if (!state) state = { count: 0, navMessageId: null };
            state.count += 1;

            if (state.count % NAV_MESSAGE_INTERVAL !== 0) {
                navState.set(message.channel.id, state);
                return;
            }

            // Delete previous navigation embed (only one at a time).
            if (state.navMessageId) {
                const prev = await message.channel.messages.fetch(state.navMessageId).catch(() => null);
                if (prev) await prev.delete().catch(() => null);
                state.navMessageId = null;
            }

            // Post new navigation embed.
            const payload = buildNavPayload(raid, guildId);
            const sent = await message.channel.send(payload).catch(() => null);
            if (sent && sent.id) state.navMessageId = sent.id;
            navState.set(message.channel.id, state);
        } catch (err) {
            // Never crash the message handler.
            try { console.warn('[raid nav] messageCreate error:', (err && err.message) || err); } catch (_) {}
        }
    }
};
