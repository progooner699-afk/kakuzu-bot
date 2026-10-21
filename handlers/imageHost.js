'use strict';

/**
 * imageHost.js — turns an EXPIRING Discord CDN attachment URL into a
 * PERMANENT, publicly hotlinkable image URL.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MessageAttachment.url` from Discord looks like:
 *   https://cdn.discordapp.com/attachments/<channel>/<id>/raid-proof.png?ex=1738...&is=...&hm=...
 * The `ex` parameter is a Unix timestamp — the signature EXPIRES. A Raid Proof
 * link built from that URL therefore dies a few hours later and returns a
 * blank page / 403 in Chrome and in the Discord mobile app. Rewriting the
 * host to `media.discordapp.net` alone does NOT fix it: the signed query
 * string is still required and still expires.
 *
 * The only durable fix is to re-host the bytes on a permanent public host.
 * Two hosts are supported (first one that is configured wins):
 *
 *   1. Supabase Storage (preferred when configured)
 *        env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET
 *        -> permanent public object URL
 *   2. catbox.moe (zero-config default)
 *        -> https://files.catbox.moe/<hash>/<name>  (permanent, already used
 *           by this bot for its default raid-card banner)
 *
 * If no host can be reached the original URL is returned after a best-effort
 * host normalisation (cdn.discordapp.com -> media.discordapp.net), so the
 * link still opens in the Discord client (which authenticates the signature)
 * instead of being dropped entirely.
 *
 * Nothing here ever logs file bytes, tokens or service-role keys.
 */

const { fetchWithTimeout } = require('./fetchTimeout');

const UPLOAD_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 10000;
// 8MB — matches the raid proof attachment ceiling already used by the result
// card. Anything bigger is not re-hosted (the link degrades gracefully).
const MAX_BYTES = 8 * 1024 * 1024;

const DISCORD_CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
// Hosts whose URLs never expire — used as-is.
const PERMANENT_HOSTS = [
    'files.catbox.moe',
    'catbox.moe',
    'i.imgur.com',
    'imgur.com',
    'supabase.co',
    'storage.googleapis.com'
];

/**
 * @param {string} url
 * @returns {boolean} true when the URL points at Discord's signed CDN.
 */
function isDiscordCdnUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        return DISCORD_CDN_HOSTS.includes(parsed.hostname.toLowerCase());
    } catch (_) {
        return false;
    }
}

/**
 * @param {string} url
 * @returns {boolean} true when the URL is already permanent.
 */
function isPermanentImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (DISCORD_CDN_HOSTS.includes(host)) return false;
        return PERMANENT_HOSTS.some(h => host === h || host.endsWith('.' + h));
    } catch (_) {
        return false;
    }
}

/**
 * Rewrites a Discord CDN URL onto the modern `media.discordapp.net` host,
 * keeping the signed query string intact. This is a best-effort fallback
 * ONLY — the signature still expires, but the link stays valid for the
 * Discord client (which authenticates it) and for mobile browsers that
 * understand the current CDN host.
 * @param {string} url
 * @returns {string}
 */
function normalizeDiscordCdnUrl(url) {
    if (!url || typeof url !== 'string') return url;
    try {
        const parsed = new URL(url);
        if (parsed.hostname.toLowerCase() === 'cdn.discordapp.com') {
            parsed.hostname = 'media.discordapp.net';
        }
        return parsed.toString();
    } catch (_) {
        return url;
    }
}

/**
 * Downloads an image into a Buffer, enforcing a size ceiling.
 * @param {string} url
 * @param {Function} [fetchImpl] test seam; defaults to the repo's bounded fetch
 * @returns {Promise<{ buffer: Buffer, contentType: string, ext: string }|null>}
 */
async function downloadImage(url, fetchImpl = fetchWithTimeout) {
    if (!url || typeof url !== 'string') return null;
    try {
        const res = await fetchImpl(url, { method: 'GET' }, DOWNLOAD_TIMEOUT_MS);
        if (!res || !res.ok) return null;
        const headers = res.headers || null;
        const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
        const contentType = String(get('content-type') || '').toLowerCase();
        if (!contentType.startsWith('image/')) return null;
        const declared = Number(get('content-length') || 0);
        if (declared > MAX_BYTES) return null;
        const buffer = Buffer.from(await res.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_BYTES) return null;
        const subtype = contentType.split('/')[1] || 'png';
        const ext = subtype.split(';')[0].replace(/[^a-z0-9]/gi, '') || 'png';
        return { buffer, contentType, ext };
    } catch (err) {
        console.warn('[imageHost] download failed:', err?.message || err);
        return null;
    }
}

/**
 * Uploads a buffer to Supabase Storage and returns its PUBLIC object URL.
 * @returns {Promise<string|null>} null when Supabase Storage is not configured
 *   or the upload failed.
 */
async function uploadToSupabaseStorage(buffer, filename, contentType) {
    const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
    const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || 'raid-proofs').trim();
    if (!supabaseUrl || !serviceKey) return null;

    // Strip credentials if someone pasted the full connection string here —
    // only the public project host is usable.
    let base = supabaseUrl;
    try {
        const parsed = new URL(supabaseUrl);
        if (parsed.password || parsed.username) return null;
        base = parsed.origin;
    } catch (_) {
        return null;
    }

    const safeName = String(filename || 'image.png').replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectPath = 'raid-proofs/' + Date.now() + '-' + safeName;
    const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');

    try {
        const res = await fetchWithTimeout(base.replace(/\/+$/, '') + '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + encodedPath, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + serviceKey,
                'apikey': serviceKey,
                'Content-Type': contentType || 'image/png',
                'x-upsert': 'false'
            },
            body: buffer
        }, UPLOAD_TIMEOUT_MS);
        if (!res || !res.ok) {
            console.warn('[imageHost] Supabase Storage upload failed with status ' + (res ? res.status : 'unknown'));
            return null;
        }
        // Public URL of a PUBLIC bucket — stable and never expires.
        const publicUrl = base.replace(/\/+$/, '') + '/storage/v1/object/public/' + encodeURIComponent(bucket) + '/' + encodedPath;

        // The bucket MUST be public. If it is private the upload succeeds but
        // the public URL answers 404/400 -> a blank page in the browser. Verify
        // the public URL actually serves the image so we can fall back to
        // another host instead of shipping a dead link.
        const reachable = await probeImageUrl(publicUrl);
        if (!reachable) {
            console.warn('[imageHost] Supabase public URL is not reachable (bucket may be private) — falling back to another host');
            return null;
        }

        return publicUrl;
    } catch (err) {
        console.warn('[imageHost] Supabase Storage upload failed:', err?.message || err);
        return null;
    }
}

/**
 * Detects whether a buffer really holds an image, by looking at the magic
 * bytes of the common web formats. Content-Type alone is NOT trustworthy:
 * catbox answers rate-limited uploads with `200 image/png` and a ZERO-byte
 * body, and a zero-byte file is exactly the "blank page" failure this whole
 * helper exists to prevent.
 *
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {boolean}
 */
function looksLikeImage(buffer, contentType) {
    if (!buffer || !buffer.length) return false;
    const type = String(contentType || '').toLowerCase();
    if (type && !type.startsWith('image/')) return false;

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 &&
        buffer[2] === 0x4E && buffer[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
    // GIF: "GIF8"
    if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'GIF8') return true;
    // WEBP: "RIFF" .... "WEBP"
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP') return true;
    // BMP: "BM"
    if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) return true;
    // AVIF/HEIC: ftyp box at offset 4
    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return true;
    // SVG: XML text that declares an <svg> root element
    if (type.includes('svg') || type.includes('xml')) {
        const head = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).toLowerCase();
        if (head.includes('<svg')) return true;
    }

    // Nothing matched a known image signature. A claimed image Content-Type
    // alone is NOT enough — a host serving an HTML error page with
    // `content-type: image/png` would otherwise be accepted.
    return false;
}

/**
 * Verifies that a hosted URL really serves the re-hosted image.
 *
 * A URL is only accepted when the request succeeds AND the body is a
 * non-empty image. This catches every failure mode we have seen in the wild:
 *   - 404 on a URL the host invented (catbox)      -> rejected
 *   - an HTML error page served with 200            -> rejected
 *   - a 0-byte "image/png" (catbox rate limit)     -> rejected
 *   - a private Supabase bucket (404 on public URL) -> rejected
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] test seam
 * @param {number} [opts.maxBytes]
 * @returns {Promise<boolean>}
 */
async function probeImageUrl(url, opts = {}) {
    const fetchImpl = opts.fetchImpl || fetchWithTimeout;
    const maxBytes = opts.maxBytes || MAX_BYTES;
    if (!url || typeof url !== 'string') return false;
    try {
        const res = await fetchImpl(url, { method: 'GET' }, DOWNLOAD_TIMEOUT_MS);
        if (!res || !res.ok) return false;
        const headers = res.headers || null;
        const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
        const contentType = String(get('content-type') || '').toLowerCase();
        if (contentType && !contentType.startsWith('image/')) return false;

        const declaredRaw = get('content-length');
        // A MISSING content-length (chunked encoding) is fine — only an
        // explicit zero is a rejection, and the body check below is the real
        // guarantee that bytes came back.
        if (declaredRaw !== null && declaredRaw !== undefined && declaredRaw !== '') {
            const declared = Number(declaredRaw);
            if (!Number.isFinite(declared)) return false;
            if (declared === 0) return false; // 0-byte body — never a usable image
            if (declared > maxBytes) return false;
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        if (!buffer.length) return false;
        if (buffer.length > maxBytes) return false;
        return looksLikeImage(buffer, contentType);
    } catch (_) {
        return false;
    }
}

/**
 * Uploads a buffer to catbox.moe — the zero-config permanent host this bot
 * already relies on for its default raid-card banner.
 * @returns {Promise<string|null>}
 */
async function uploadToCatbox(buffer, filename, contentType, opts = {}) {
    const uploadImpl = opts.uploadImpl || null;
    const probeImpl = opts.probeImpl || null;
    const attempts = Number.isInteger(opts.attempts) ? opts.attempts : 3;
    const retryDelayMs = Number.isInteger(opts.retryDelayMs) ? opts.retryDelayMs : 1500;

    let lastReason = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let res;
        try {
            if (uploadImpl) {
                res = await uploadImpl({ buffer, filename, contentType, attempt });
            } else {
                const form = new FormData();
                form.append('reqtype', 'fileupload');
                form.append('fileToUpload', new Blob([buffer], { type: contentType || 'image/png' }), filename || 'image.png');
                res = await fetchWithTimeout('https://catbox.moe/user/api.php', {
                    method: 'POST',
                    body: form
                }, UPLOAD_TIMEOUT_MS);
            }
        } catch (err) {
            lastReason = 'upload error: ' + (err?.message || err);
            res = null;
        }

        if (res && res.ok) {
            let text = '';
            try {
                text = typeof res.text === 'function' ? String(await res.text()).trim() : '';
            } catch (err) {
                lastReason = 'unreadable body: ' + (err?.message || err);
                text = '';
            }
            if (!text) {
                // catbox rate-limits by answering 200 with an EMPTY body.
                lastReason = 'empty response body';
            } else if (!/^https?:\/\//i.test(text)) {
                // catbox answers with a plain-text error ("File type is not
                // permitted") instead of a URL.
                lastReason = 'non-URL response: ' + text.slice(0, 120);
            } else {
                // The URL looks right — but catbox can still hand back a link
                // that 404s or serves a 0-byte file. Ship it only if it really
                // serves the image.
                const reachable = await probeImageUrl(text, probeImpl ? { fetchImpl: probeImpl } : {});
                if (reachable) return text;
                lastReason = 'returned URL does not serve the image';
            }
        } else if (res) {
            lastReason = 'HTTP ' + res.status;
        }

        if (attempt < attempts) {
            // Back off a little: catbox's limit window is short and a burst
            // of uploads keeps every retry failing.
            await new Promise(r => setTimeout(r, retryDelayMs * attempt));
        }
    }

    console.warn('[imageHost] catbox upload failed (' + lastReason + ')');
    return null;
}

/**
 * Turns an image URL into a PERMANENT public URL.
 *
 * - Already-permanent hosts (catbox, imgur, supabase) are returned untouched.
 * - Discord CDN URLs (signed, expiring) are downloaded and re-hosted.
 * - Supabase Storage is used when configured; otherwise catbox.moe.
 * - On ANY failure the normalised Discord URL is returned as a best effort,
 *   so the link is never dropped.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] test seam
 * @param {Function} [opts.uploader] test seam; receives (buffer, filename, contentType)
 * @param {Function} [opts.catboxUploader] test seam for the catbox fallback
 * @returns {Promise<string>}
 */
async function makePermanentImageUrl(url, opts = {}) {
    const fetchImpl = opts.fetchImpl || fetchWithTimeout;
    if (!url || typeof url !== 'string') return url;

    if (isPermanentImageUrl(url)) return url;

    if (!isDiscordCdnUrl(url)) {
        // Unknown host: leave it alone (it may already be a stable public URL).
        return url;
    }

    const downloaded = await downloadImage(url, fetchImpl);
    if (!downloaded) {
        // Could not re-host — fall back to the modern CDN host so the link
        // still opens in the Discord client and in mobile browsers.
        return normalizeDiscordCdnUrl(url);
    }

    const filename = 'raid-proof-' + Date.now() + '.' + (downloaded.ext || 'png');
    const uploader = opts.uploader || uploadToSupabaseStorage;
    let hosted = null;
    try {
        hosted = await uploader(downloaded.buffer, filename, downloaded.contentType);
    } catch (err) {
        console.warn('[imageHost] uploader threw:', err?.message || err);
        hosted = null;
    }

    if (!hosted) {
        try {
            const catboxUploader = opts.catboxUploader || uploadToCatbox;
            hosted = await catboxUploader(downloaded.buffer, filename, downloaded.contentType, {
                probeImpl: opts.probeImpl
            });
        } catch (err) {
            console.warn('[imageHost] catbox fallback threw:', err?.message || err);
        }
    }

    if (!hosted) return normalizeDiscordCdnUrl(url);
    return hosted;
}

module.exports = {
    makePermanentImageUrl,
    isDiscordCdnUrl,
    isPermanentImageUrl,
    normalizeDiscordCdnUrl,
    downloadImage,
    uploadToSupabaseStorage,
    uploadToCatbox,
    probeImageUrl,
    looksLikeImage,
    MAX_BYTES
};

