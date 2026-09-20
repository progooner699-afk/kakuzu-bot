'use strict';
/* accessLog.js — public audit log (#kakuzu-access-logs) in support server. */

const {
    EmbedBuilder,
    ChannelType,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags,
} = require('discord.js');

const ACCESS_LOG_CHANNEL_NAME = 'kakuzu-access-logs';
const ACCESS_LOG_GRANTED_COLOR = 0x2ECC71;
const ACCESS_LOG_REVOKED_COLOR = 0xE74C3C;
const ACCESS_LOG_V2_FLAGS = MessageFlags.IsComponentsV2;

function getAccessLogChannelId() { return String(process.env.ACCESS_LOG_CHANNEL_ID || '').trim(); }
function v2Text(c) { return new TextDisplayBuilder().setContent(String(c).slice(0, 4000)).toJSON(); }
function v2Sep() { return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small).toJSON(); }
function fmtStamp(d) {
    try {
        const dt = d instanceof Date ? d : new Date(d || Date.now());
        const s = Math.floor(dt.getTime() / 1000);
        return '<t:' + s + ':F> • <t:' + s + ':R>';
    } catch (_) { return String(d || 'Unknown'); }
}

function buildAccessLogV2Payload(kind, o) {
    const data = o || {};
    const revoked = String(kind || '') === 'revoked';
    const dot = revoked ? '🔴' : '🟢';
    const title = revoked ? '# 🔴 KAKUZU ACCESS REVOKED' : '# 🟢 KAKUZU ACCESS GRANTED';
    const gName = String(data.guildName || 'Unknown server');
    const gid = String(data.guildId || 'unknown');
    const link = String(data.joinLink || '');
    const joinLine = link ? '[Join ' + gName + '](' + link + ')' : '`No invite available`';
    const own = String(data.ownerId || '');
    const ownLine = own ? '<@' + own + '>' : '`Unknown`';
    const by = String(data.performedById || '');
    const byLine = by ? '<@' + by + '>' : '`Unknown`';
    const head = revoked
        ? title + '\n\n❌ **' + gName + '** has lost **Kakuzu Premium**'
        : title + '\n\n✅ **' + gName + '** has unlocked **Kakuzu Premium**';
    const actionWord = revoked ? 'Revoked' : 'Activated';
    const statusLine = revoked ? '🔴 **Status:** Inactive' : '🟢 **Status:** Active';
    const reason = (!revoked || !data.reason) ? '' : '\n📝 **Reason:** ' + String(data.reason).slice(0, 300);
    const sections = [
        head,
        '## 🏰 SERVER DETAILS\n\n🏷️ **Server:** ' + gName + '\n🆔 **Server ID:** `' + gid + '`\n🔗 **Join:** ' + joinLine,
        '## 👑 OWNERSHIP\n\n👤 **Owner:** ' + ownLine,
        '## 🛡️ ACCESS RECORD\n\n📅 **' + actionWord + ':** ' + fmtStamp(data.at) + '\n🛡️ **' + (revoked ? 'Revoked' : 'Granted') + ' by:** ' + byLine + '\n💎 **Plan:** Kakuzu Premium\n' + statusLine + reason,
        '-# 🔒 Premium access is authorized only for this server.',
    ];
    const content = [];
    sections.forEach((b) => { content.push(v2Text(b)); content.push(v2Sep()); });
    const box = new ContainerBuilder().setAccentColor(revoked ? ACCESS_LOG_REVOKED_COLOR : ACCESS_LOG_GRANTED_COLOR).toJSON();
    box.size = 'large';
    box.components = content;
    return { components: [box], flags: ACCESS_LOG_V2_FLAGS, allowedMentions: { parse: [] } };
}

function buildAccessLogFallbackEmbed(kind, o) {
    const data = o || {};
    const revoked = String(kind || '') === 'revoked';
    const gName = String(data.guildName || 'Unknown server');
    const gid = String(data.guildId || 'unknown');
    const link = String(data.joinLink || '');
    const own = String(data.ownerId || '');
    const by = String(data.performedById || '');
    const e = new EmbedBuilder()
        .setTitle(revoked ? '🔴 KAKUZU ACCESS REVOKED' : '🟢 KAKUZU ACCESS GRANTED')
        .setDescription((revoked ? '❌ **' : '✅ **') + gName + '** has ' + (revoked ? 'lost' : 'unlocked') + ' **Kakuzu Premium**');
    e.addFields(
        { name: '🏰 SERVER DETAILS', value: '🏷️ **Server:** ' + gName + '\n🆔 **Server ID:** `' + gid + '`\n🔗 **Join:** ' + (link ? '[Join ' + gName + '](' + link + ')' : '`No invite available`'), inline: false },
        { name: '👑 OWNERSHIP', value: '👤 **Owner:** ' + (own ? '<@' + own + '>' : '`Unknown`'), inline: false },
        { name: '🛡️ ACCESS RECORD', value: '📅 **' + (revoked ? 'Revoked' : 'Activated') + ':** ' + fmtStamp(data.at) + '\n🛡️ **' + (revoked ? 'Revoked' : 'Granted') + ' by:** ' + (by ? '<@' + by + '>' : '`Unknown`') + '\n💎 **Plan:** Kakuzu Premium\n' + (revoked ? '🔴 **Status:** Inactive' : '🟢 **Status:** Active') + ((!revoked || !data.reason) ? '' : '\n📝 **Reason:** ' + String(data.reason).slice(0, 300)), inline: false },
    );
    e.setColor(revoked ? ACCESS_LOG_REVOKED_COLOR : ACCESS_LOG_GRANTED_COLOR);
    e.setFooter({ text: '🔒 Premium access is authorized only for this server.' });
    e.setTimestamp(data.at instanceof Date ? data.at : new Date());
    return { embeds: [e], allowedMentions: { parse: [] } };
}

async function resolveAccessLogChannel(client) {
    let guildAccess = null;
    try { guildAccess = require('./guildAccess'); } catch (_) { guildAccess = null; }
    const supportId = guildAccess ? guildAccess.getSupportGuildId() : String(process.env.SUPPORT_GUILD_ID || '').trim();
    if (!supportId || !client) return null;
    let sg = null;
    try { sg = client.guilds.cache.get(String(supportId)) || await client.guilds.fetch(String(supportId)).catch(() => null); } catch (_) { sg = null; }
    if (!sg) return null;
    const cfg = getAccessLogChannelId();
    if (cfg) {
        try {
            const ch = await sg.channels.fetch(String(cfg)).catch(() => null);
            if (ch && ch.isTextBased && ch.isTextBased()) return ch;
        } catch (_) {}
    }
    try {
        const cache = sg.channels.cache;
        const found = cache && cache.find ? cache.find((c) => c && c.name === ACCESS_LOG_CHANNEL_NAME)
            : [...(cache || new Map()).values()].find((c) => c && c.name === ACCESS_LOG_CHANNEL_NAME);
        if (found && found.isTextBased && found.isTextBased()) return found;
    } catch (_) {}
    try {
        const created = await sg.channels.create({
            name: ACCESS_LOG_CHANNEL_NAME,
            type: ChannelType.GuildText,
            topic: 'Kakuzu premium access grants and revokes — server, join link, owner, date, granted-by.',
            reason: 'Kakuzu access audit log',
        }).catch(() => null);
        if (created && created.isTextBased && created.isTextBased()) return created;
    } catch (e) { console.warn('[accessLog] channel create failed:', (e && e.message) || e); }
    return null;
}

async function createTargetServerInvite(client, gid) {
    try {
        const guild = client && client.guilds ? (client.guilds.cache.get(String(gid)) || await client.guilds.fetch(String(gid)).catch(() => null)) : null;
        if (!guild) return '';
        try {
            const vanity = await guild.fetchVanityData().catch(() => null);
            if (vanity && vanity.code) return 'https://discord.gg/' + vanity.code;
        } catch (_) {}
        try {
            const invs = await guild.invites.fetch().catch(() => null);
            const first = invs && invs.first ? invs.first() : (invs && invs.size ? [...invs.values()][0] : null);
            if (first && first.url) return first.url;
            if (first && first.code) return 'https://discord.gg/' + first.code;
        } catch (_) {}
        let ch = null;
        try {
            if (guild.systemChannel && guild.systemChannel.isTextBased && guild.systemChannel.isTextBased()) ch = guild.systemChannel;
            else ch = [...(guild.channels.cache || new Map()).values()].find((c) => c && c.isTextBased && c.isTextBased() && !c.isThread());
        } catch (_) { ch = null; }
        if (!ch || !ch.createInvite) return '';
        const inv = await ch.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: 'Kakuzu access log join link' }).catch(() => null);
        if (inv && inv.url) return inv.url;
        if (inv && inv.code) return 'https://discord.gg/' + inv.code;
    } catch (e) { console.warn('[accessLog] invite create failed:', (e && e.message) || e); }
    return '';
}

async function postAccessLog(client, kind, opts) {
    try {
        const ch = await resolveAccessLogChannel(client);
        if (!ch) { console.warn('[accessLog] channel unavailable — skipping log post.'); return null; }
        try { return await ch.send(buildAccessLogV2Payload(kind, opts || {})); }
        catch (e) {
            console.warn('[accessLog] V2 log rejected — embed fallback:', (e && e.message) || e);
            try { return await ch.send(buildAccessLogFallbackEmbed(kind, opts || {})); } catch (_) { return null; }
        }
    } catch (e) { console.warn('[accessLog] post failed:', (e && e.message) || e); return null; }
}

module.exports = {
    ACCESS_LOG_CHANNEL_NAME,
    ACCESS_LOG_V2_FLAGS,
    getAccessLogChannelId,
    buildAccessLogV2Payload,
    buildAccessLogFallbackEmbed,
    resolveAccessLogChannel,
    createTargetServerInvite,
    postAccessLog,
};
