'use strict';

/*
 * image-host.test.js — pins the "Raid Proof links must never expire" fix.
 *
 * Root cause: Discord CDN attachment URLs carry a SIGNED, EXPIRING query
 * string (?ex=...&is=...&hm=...). A "Raid Proof: Image 1" markdown link built
 * from one of those returns a blank page / 403 in Chrome and in the Discord
 * mobile app as soon as the signature dies.
 *
 * Contract pinned here:
 *  1. Expiring Discord CDN URLs are re-hosted on a PERMANENT public host.
 *  2. Already-permanent hosts (catbox / imgur / supabase) are untouched.
 *  3. Any failure degrades to the host-normalised Discord URL (media.discordapp.net)
 *     instead of dropping the link.
 *  4. The result card renders the proof as CLICKABLE markdown links.
 *  5. makePermanentUrls keeps the original list order + length.
 */

const test = require('node:test');
const assert = require('node:assert');

const imageHost = require('../handlers/imageHost');
const raidResultCard = require('../handlers/raidResultCard');
const interactionCreate = require('../events/interactionCreate');

const EXPIRING = 'https://cdn.discordapp.com/attachments/111/222/raid-proof.png?ex=1738000000&is=601800000&hm=abc';
const PERMANENT = 'https://files.catbox.moe/iyqyrd.gif';

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4]);

function fakeFetch({ ok = true, contentType = 'image/png', body = FAKE_PNG } = {}) {
    return async () => ({
        ok,
        status: ok ? 200 : 404,
        headers: {
            get(name) {
                if (name === 'content-type') return contentType;
                if (name === 'content-length') return String(body.length);
                return null;
            }
        },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    });
}

test('expiring Discord CDN URLs are detected and normalised to media.discordapp.net', () => {
    assert.strictEqual(imageHost.isDiscordCdnUrl(EXPIRING), true);
    assert.strictEqual(imageHost.isDiscordCdnUrl('https://media.discordapp.net/attachments/1/2/a.png?ex=1'), true);
    assert.strictEqual(imageHost.isDiscordCdnUrl(PERMANENT), false);
    assert.strictEqual(imageHost.isDiscordCdnUrl(''), false);
    assert.strictEqual(imageHost.isDiscordCdnUrl(null), false);
    assert.strictEqual(imageHost.isDiscordCdnUrl('not a url'), false);

    const normalised = imageHost.normalizeDiscordCdnUrl(EXPIRING);
    assert.ok(normalised.startsWith('https://media.discordapp.net/attachments/111/222/raid-proof.png'),
        'host must become media.discordapp.net');
    assert.ok(normalised.includes('ex=1738000000'), 'the signed query string must be preserved');
});

test('already-permanent hosts are recognised and never touched', () => {
    assert.strictEqual(imageHost.isPermanentImageUrl(PERMANENT), true);
    assert.strictEqual(imageHost.isPermanentImageUrl('https://i.imgur.com/abc.png'), true);
    assert.strictEqual(imageHost.isPermanentImageUrl('https://xyz.supabase.co/storage/v1/object/public/b/o.png'), true);
    assert.strictEqual(imageHost.isPermanentImageUrl(EXPIRING), false, 'a signed Discord URL is never permanent');
});

test('an expiring Discord URL is re-hosted and the permanent URL is returned', async () => {
    let uploaded = null;
    const result = await imageHost.makePermanentImageUrl(EXPIRING, {
        fetchImpl: fakeFetch(),
        uploader: async (buffer, filename, contentType) => {
            uploaded = { buffer, filename, contentType };
            return 'https://files.catbox.moe/permanent123/raid-proof.png';
        }
    });
    assert.strictEqual(result, 'https://files.catbox.moe/permanent123/raid-proof.png');
    assert.ok(uploaded, 'the uploader must have been called');
    assert.ok(uploaded.buffer.length > 0);
    assert.ok(uploaded.filename.endsWith('.png'));
    assert.strictEqual(uploaded.contentType, 'image/png');
});

test('a permanent URL is returned untouched without any download or upload', async () => {
    let fetched = false;
    let uploaded = false;
    const result = await imageHost.makePermanentImageUrl(PERMANENT, {
        fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
        uploader: async () => { uploaded = true; return 'https://nope'; }
    });
    assert.strictEqual(result, PERMANENT);
    assert.strictEqual(fetched, false, 'permanent URLs are not re-downloaded');
    assert.strictEqual(uploaded, false, 'permanent URLs are not re-uploaded');
});

test('a failed re-host degrades to the normalised Discord URL (link is never dropped)', async () => {
    const failedDownload = await imageHost.makePermanentImageUrl(EXPIRING, {
        fetchImpl: fakeFetch({ ok: false }),
        uploader: async () => 'https://files.catbox.moe/x.png'
    });
    assert.ok(failedDownload.startsWith('https://media.discordapp.net/attachments/111/222/raid-proof.png'),
        'a failed download falls back to the modern CDN host');

    const failedUpload = await imageHost.makePermanentImageUrl(EXPIRING, {
        fetchImpl: fakeFetch(),
        uploader: async () => null,
        catboxUploader: async () => null
    });
    assert.ok(typeof failedUpload === 'string' && failedUpload.length > 0, 'never returns empty');
    assert.ok(failedUpload.includes('media.discordapp.net') || failedUpload.includes('cdn.discordapp.com'),
        'falls back to a Discord CDN URL when no host is reachable');
});

test('catbox is used as the fallback host when the primary uploader returns null', async () => {
    let catboxCalled = false;
    const result = await imageHost.makePermanentImageUrl(EXPIRING, {
        fetchImpl: fakeFetch(),
        uploader: async () => null,
        catboxUploader: async (buffer, filename) => {
            catboxCalled = true;
            assert.ok(buffer.length > 0);
            assert.ok(filename.endsWith('.png'));
            return 'https://files.catbox.moe/catboxfallback.png';
        }
    });
    assert.strictEqual(catboxCalled, true, 'the catbox fallback must be used');
    assert.strictEqual(result, 'https://files.catbox.moe/catboxfallback.png');
});

test('a thrown uploader is caught and degrades gracefully', async () => {
    const result = await imageHost.makePermanentImageUrl(EXPIRING, {
        fetchImpl: fakeFetch(),
        uploader: async () => { throw new Error('host down'); },
        catboxUploader: async () => null
    });
    assert.ok(result && result.length > 0);
});

test('makePermanentUrls preserves order and length and never throws', async () => {
    const urls = await interactionCreate.makePermanentUrls([EXPIRING, PERMANENT, 'https://example.org/x.png'], {
        fetchImpl: fakeFetch(),
        uploader: async () => 'https://files.catbox.moe/rehosted.png'
    });
    assert.strictEqual(urls.length, 3, 'length preserved');
    assert.strictEqual(urls[0], 'https://files.catbox.moe/rehosted.png', 'expiring URL re-hosted');
    assert.strictEqual(urls[1], PERMANENT, 'permanent URL untouched');
    assert.strictEqual(urls[2], 'https://example.org/x.png', 'unknown host left alone');

    assert.deepStrictEqual(await interactionCreate.makePermanentUrls([]), []);
    assert.deepStrictEqual(await interactionCreate.makePermanentUrls(null), []);
});


test('a catbox URL that 404s is DISCARDED (never shipped as a dead "Image 1" link)', async () => {
    // catbox sometimes accepts the upload but answers with a URL that 404s.
    // The uploader must probe it and refuse to return a dead URL.
    const uploadImpl = async () => ({ ok: true, status: 200, text: async () => 'https://files.catbox.moe/dead.png' });
    const noRetry = { attempts: 1, retryDelayMs: 0 };

    const dead = await imageHost.uploadToCatbox(FAKE_PNG, 'x.png', 'image/png', {
        uploadImpl,
        probeImpl: async () => ({ ok: false, status: 404, headers: { get: () => 'text/html' } }),
        ...noRetry
    });
    assert.strictEqual(dead, null, 'a 404 URL is discarded');

    // A URL that serves a non-image is discarded too.
    const notImage = await imageHost.uploadToCatbox(FAKE_PNG, 'x.png', 'image/png', {
        uploadImpl,
        probeImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' } }),
        ...noRetry
    });
    assert.strictEqual(notImage, null, 'a non-image URL is discarded');

    // A healthy URL is returned.
    const good = await imageHost.uploadToCatbox(FAKE_PNG, 'x.png', 'image/png', {
        uploadImpl,
        probeImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: (n) => (n === 'content-type' ? 'image/png' : n === 'content-length' ? String(FAKE_PNG.length) : null) },
            arrayBuffer: async () => FAKE_PNG.buffer.slice(FAKE_PNG.byteOffset, FAKE_PNG.byteOffset + FAKE_PNG.byteLength)
        }),
        ...noRetry
    });
    assert.strictEqual(good, 'https://files.catbox.moe/dead.png', 'a reachable image URL is kept');
});

test('a ZERO-BYTE "image/png" body is rejected (catbox rate-limit response)', async () => {
    // This is the exact failure seen in the wild: catbox answers a rate-limited
    // upload with HTTP 200, `content-type: image/png` and content-length 0.
    // Accepting it would ship a link that renders as a blank page.
    const uploadImpl = async () => ({ ok: true, status: 200, text: async () => 'https://files.catbox.moe/empty.png' });
    const zeroByte = await imageHost.uploadToCatbox(FAKE_PNG, 'x.png', 'image/png', {
        uploadImpl,
        probeImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: (n) => (n === 'content-type' ? 'image/png' : n === 'content-length' ? '0' : null) },
            arrayBuffer: async () => new ArrayBuffer(0)
        }),
        attempts: 1,
        retryDelayMs: 0
    });
    assert.strictEqual(zeroByte, null, 'a 0-byte image is discarded');
});

test('an EMPTY upload body (catbox rate limit) is retried and then discarded', async () => {
    let calls = 0;
    const emptyBody = async () => {
        calls++;
        return { ok: true, status: 200, text: async () => '' };
    };
    const result = await imageHost.uploadToCatbox(FAKE_PNG, 'x.png', 'image/png', {
        uploadImpl: emptyBody,
        attempts: 3,
        retryDelayMs: 0
    });
    assert.strictEqual(result, null, 'no URL is invented from an empty response');
    assert.strictEqual(calls, 3, 'the upload is retried before giving up');
});

test('a non-URL catbox error body is discarded', async () => {
    const errorBody = async () => ({ ok: true, status: 200, text: async () => 'File type is not permitted' });
    const result = await imageHost.uploadToCatbox(FAKE_PNG, 'x.txt', 'text/plain', {
        uploadImpl: errorBody,
        attempts: 1,
        retryDelayMs: 0
    });
    assert.strictEqual(result, null, 'an error body is never used as a URL');
});

test('a chunked response with NO content-length but real bytes is accepted', async () => {
    // Some hosts (and Supabase behind a CDN) answer with `transfer-encoding:
    // chunked` and no content-length. That must NOT be rejected — only an
    // explicit zero length or an empty body is a failure.
    const chunked = await imageHost.probeImageUrl('https://files.catbox.moe/chunked.png', {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: (n) => (n === 'content-type' ? 'image/png' : null) },
            arrayBuffer: async () => FAKE_PNG.buffer.slice(FAKE_PNG.byteOffset, FAKE_PNG.byteOffset + FAKE_PNG.byteLength)
        })
    });
    assert.strictEqual(chunked, true, 'a chunked image response is accepted');
});

test('looksLikeImage recognises real image magic bytes', () => {
    assert.ok(imageHost.looksLikeImage(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'image/png'));
    assert.ok(imageHost.looksLikeImage(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), 'image/jpeg'));
    assert.ok(imageHost.looksLikeImage(Buffer.from('GIF89a....', 'ascii'), 'image/gif'));
    assert.ok(!imageHost.looksLikeImage(Buffer.alloc(0), 'image/png'), 'an empty buffer is not an image');
    assert.ok(!imageHost.looksLikeImage(Buffer.from('<html></html>'), 'image/png'), 'html is not an image');
    assert.ok(!imageHost.looksLikeImage(Buffer.from('x'), 'text/html'), 'html content-type is rejected');
});

test('makePermanentUrls never returns a shorter array than it was given', async () => {
    // Position preservation matters: the caller slices the result into
    // "proof URLs" and the "rally URL".
    const urls = await interactionCreate.makePermanentUrls(
        [EXPIRING, '', null, PERMANENT],
        { fetchImpl: fakeFetch(), uploader: async () => 'https://files.catbox.moe/rehosted.png' }
    );
    assert.strictEqual(urls.length, 4, 'length preserved even with empty entries');
    assert.strictEqual(urls[0], 'https://files.catbox.moe/rehosted.png');
    assert.strictEqual(urls[3], PERMANENT);
});

test('the proof field never cuts a markdown link in half', () => {
    // 8 very long URLs would overflow Discord's 1024-char field limit.
    const longUrls = [];
    for (let i = 0; i < 8; i++) longUrls.push('https://files.catbox.moe/' + 'x'.repeat(200) + i + '.png');
    const value = raidResultCard.buildProofLinks(longUrls);
    assert.ok(value.length <= 1024, 'the field stays inside the Discord limit');
    // Every "[" must be matched by a ")" — no half-open markdown link.
    const opens = (value.match(/\[/g) || []).length;
    const closes = (value.match(/\)/g) || []).length;
    assert.strictEqual(opens, closes, 'no unbalanced markdown link');
    assert.ok(value.startsWith('[Image 1]('), 'the first link is complete');
});

test('buildProofLinks caps at 8 links and reports an empty upload', () => {
    const many = [];
    for (let i = 0; i < 20; i++) many.push('https://files.catbox.moe/p' + i + '.png');
    const value = raidResultCard.buildProofLinks(many);
    assert.ok(value.includes('[Image 8]('), 'eight links are rendered');
    assert.ok(!value.includes('[Image 9]('), 'no ninth link');
    assert.strictEqual(raidResultCard.buildProofLinks([]), 'No raid pictures uploaded.');
});

test('the fallback result embed renders Raid Proof as CLICKABLE markdown links', () => {
    const embed = raidResultCard.buildResultFallbackEmbed({
        raid: { raidId: 5, helpers: [], createdAt: 1, closedAt: 2 },
        outcome: 'win',
        submitterId: '1',
        proofUrls: ['https://files.catbox.moe/a.png', 'https://files.catbox.moe/b.png'],
        streakMessage: '**Current Streak:** None tracking'
    });
    const field = embed.data.fields.find(f => f.name === '📸 Raid Proof');
    assert.ok(field, 'Raid Proof field exists');
    assert.ok(field.value.includes('[Image 1](https://files.catbox.moe/a.png)'),
        'Image 1 must be a markdown link, got: ' + field.value);
    assert.ok(field.value.includes('[Image 2](https://files.catbox.moe/b.png)'),
        'Image 2 must be a markdown link, got: ' + field.value);
    assert.strictEqual(embed.data.image, undefined, 'the embed stays image-free (full width)');
});

test('the V2 result card renders Raid Proof as CLICKABLE markdown links', () => {
    const payload = raidResultCard.buildResultCardPayload({
        raid: { raidId: 5, helpers: [], createdAt: 1, closedAt: 2 },
        outcome: 'win',
        submitterId: '1',
        proofUrls: ['https://files.catbox.moe/a.png'],
        streakMessage: '**Current Streak:** None tracking'
    });
    const json = JSON.stringify(payload);
    assert.ok(json.includes('[Image 1](https://files.catbox.moe/a.png)'),
        'the V2 card must link "Image 1", got: ' + json);
});

test('downloadImage rejects non-images and oversized bodies before re-hosting', async () => {
    // The download step is the gate that keeps junk out of the permanent host:
    // only a real `image/*` body below the 8MB ceiling may be re-hosted.
    assert.strictEqual(await imageHost.downloadImage('', fakeFetch()), null, 'an empty URL is rejected');
    assert.strictEqual(await imageHost.downloadImage(null, fakeFetch()), null, 'a null URL is rejected');
    assert.strictEqual(await imageHost.downloadImage(EXPIRING, fakeFetch({ ok: false })), null, 'a 404 is rejected');
    assert.strictEqual(
        await imageHost.downloadImage(EXPIRING, fakeFetch({ contentType: 'text/html' })),
        null,
        'an HTML body is rejected even when the bytes look like a PNG'
    );

    // A declared length above the ceiling is refused BEFORE the body is read.
    const oversized = await imageHost.downloadImage(EXPIRING, async () => ({
        ok: true,
        status: 200,
        headers: {
            get: (n) => (n === 'content-type' ? 'image/png'
                : n === 'content-length' ? String(imageHost.MAX_BYTES + 1) : null)
        },
        arrayBuffer: async () => FAKE_PNG.buffer.slice(FAKE_PNG.byteOffset, FAKE_PNG.byteOffset + FAKE_PNG.byteLength)
    }));
    assert.strictEqual(oversized, null, 'an image above the 8MB ceiling is rejected');

    // A healthy image is downloaded and reports its content type + extension.
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]);
    const downloaded = await imageHost.downloadImage(EXPIRING, fakeFetch({ contentType: 'image/jpeg', body: jpeg }));
    assert.ok(downloaded, 'a real image is downloaded');
    assert.strictEqual(downloaded.contentType, 'image/jpeg');
    assert.strictEqual(downloaded.ext, 'jpeg', 'the extension follows the content type');
    assert.strictEqual(downloaded.buffer.length, jpeg.length, 'the bytes are preserved');
});
