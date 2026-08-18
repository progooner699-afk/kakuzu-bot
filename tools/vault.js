'use strict';

/**
 * KAKUZU PANIC VAULT — reversible lockdown tool.
 *
 * Encrypts the bot's sensitive files (`.env` and `data/`) into AES-256-GCM
 * ciphertext so that if the host filesystem or repo folder is hacked/leaked,
 * the attacker gets NOTHING usable. Fully reversible with `unlock`.
 *
 * SAFETY (guaranteed undo):
 *   - The passphrase is the ONLY thing that can decrypt. It is read from the
 *     VAULT_PASS environment variable and is NEVER written to disk.
 *   - `lock` WITHOUT `--wipe` only creates the encrypted archives (non-
 *     destructive). Plaintext is deleted ONLY when you explicitly pass
 *     `--wipe`, and only AFTER a dry-run decrypt + hash check proves the
 *     archive is restorable.
 *   - `unlock` restores every original file and verifies hashes.
 *
 * USAGE:
 *   set VAULT_PASS=<your passphrase> (>= 8 chars, save it somewhere safe!)
 *   node tools/vault.js status
 *   node tools/vault.js lock                # create encrypted archives only
 *   node tools/vault.js lock --wipe         # archives + delete plaintext
 *   node tools/vault.js unlock              # restore .env + data/ from archives
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VAULT_DIR = path.join(ROOT, '.vault');
const ARCHIVES = [
    { enc: 'env.enc', source: path.join(ROOT, '.env'), label: 'env' },
    { enc: 'data.enc', source: path.join(ROOT, 'data'), label: 'data' }
];
const MAGIC = 'KAKUZU_VAULT_V1';
const MIN_PASS_LEN = 8;

function getPass() {
    const p = process.env.VAULT_PASS;
    if (!p || p.length < MIN_PASS_LEN) {
        console.error(`ERROR: set VAULT_PASS to a passphrase of at least ${MIN_PASS_LEN} characters.`);
        console.error('This passphrase is the ONLY way to undo a lock. Store it somewhere safe (off this machine).');
        process.exit(1);
    }
    return p;
}

function getKey(pass) {
    // Deterministic 32-byte AES-256 key from the passphrase (scrypt).
    const salt = crypto.createHash('sha256').update('kakuzu-vault-salt-v1').digest();
    return crypto.scryptSync(pass, salt, 32);
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function encryptBuffer(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), authTag: authTag.toString('base64'), data: enc.toString('base64'), sha256: sha256(plaintext) };
}

function decryptBuffer(key, envelope) {
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.authTag, 'base64');
    const enc = Buffer.from(envelope.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(enc), decipher.final()]);
    return pt;
}

function encryptDirToBuffer(rootDir) {
    if (!fs.existsSync(rootDir)) return null;
    const manifest = {};
    const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(abs, relPath);
            } else {
                manifest[relPath] = fs.readFileSync(abs).toString('base64');
            }
        }
    };
    walk(rootDir, '');
    return { files: manifest };
}

function restoreDirFromBuffer(rootDir, payload) {
    if (!payload || !payload.files) throw new Error('data archive has no files manifest');
    for (const [relPath, b64] of Object.entries(payload.files)) {
        const abs = path.join(rootDir, relPath.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
    }
}

function lockOne(key, target, encPath) {
    if (!fs.existsSync(target)) {
        console.log(`  · none found: ${path.relative(ROOT, target)} -> skipped`);
        return null;
    }
    const isDir = fs.statSync(target).isDirectory();
    const plaintext = isDir
        ? Buffer.from(JSON.stringify(encryptDirToBuffer(target)), 'utf8')
        : fs.readFileSync(target);
    const envelope = Object.assign({ magic: MAGIC, kind: isDir ? 'dir' : 'file', label: path.basename(target) }, encryptBuffer(key, plaintext));
    fs.mkdirSync(VAULT_DIR, { recursive: true });
    fs.writeFileSync(encPath, JSON.stringify(envelope));
    return envelope;
}

function verifyRestore(key, envelope, target) {
    // Dry-run: decrypt and compare hashes WITHOUT touching plaintext.
    const plaintext = decryptBuffer(key, envelope);
    const restoredSha = sha256(plaintext);
    if (restoredSha !== envelope.sha256) throw new Error('decrypted archive hash mismatch');
    if (envelope.kind === 'dir') {
        const payload = JSON.parse(plaintext.toString('utf8'));
        if (payload === null || payload.files === undefined) {
            throw new Error('dir archive contents invalid');
        }
    }
    return plaintext;
}

function doLock(wipe) {
    const pass = getPass();
    const key = getKey(pass);
    console.log('Locking sensitive files into .vault/ ...');
    const created = [];
    for (const a of ARCHIVES) {
        const env = lockOne(key, a.source, path.join(VAULT_DIR, a.enc));
        if (env) {
            // Prove we can decrypt it before ANY plaintext is touched.
            verifyRestore(key, env, a.source);
            created.push(a);
            console.log(`  · encrypted ${path.relative(ROOT, a.source)} -> .vault/${a.enc} (verified restorable)`);
        }
    }
    if (created.length === 0) {
        console.log('Nothing to lock.');
        return;
    }
    if (wipe) {
        for (const a of created) {
            try {
                fs.rmSync(a.source, { recursive: true, force: true });
                console.log(`  · wiped plaintext: ${path.relative(ROOT, a.source)}`);
            } catch (e) {
                console.error(`  · could not wipe ${a.source}: ${e.message}`);
            }
        }
        console.log('LOCKED. Plaintext removed. Only ciphertext remains — a hacker gets nothing.');
        console.log('   Undo anytime with:  node tools/vault.js unlock   (same VAULT_PASS)');
    } else {
        console.log('Archives created (plaintext kept — run with --wipe to remove it).');
    }
}

function readEnvelope(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.magic !== MAGIC) throw new Error(`${file} is not a Kakuzu vault archive`);
    return raw;
}
function doUnlock() {
    const pass = getPass();
    const key = getKey(pass);
    console.log('Unlocking ...');
    let any = false;
    for (const a of ARCHIVES) {
        const encPath = path.join(VAULT_DIR, a.enc);
        if (!fs.existsSync(encPath)) {
            console.log(`  · no archive for ${path.basename(a.source)}`);
            continue;
        }
        const envelope = readEnvelope(encPath);
        const plaintext = decryptBuffer(key, envelope);
        const restored = sha256(plaintext);
        if (restored !== envelope.sha256) {
            console.error(`  · FAILED hash check for ${a.enc} (wrong passphrase or corrupted archive)`);
            continue;
        }
        if (envelope.kind === 'dir') {
            restoreDirFromBuffer(a.source, JSON.parse(plaintext.toString('utf8')));
        } else {
            fs.mkdirSync(path.dirname(a.source), { recursive: true });
            fs.writeFileSync(a.source, plaintext);
        }
        any = true;
        console.log(`  · restored ${path.relative(ROOT, a.source)}`);
    }
    if (any) console.log('UNLOCKED. Original files restored.');
    else console.log('Nothing to unlock.');
}

function doStatus() {
    console.log('Vault status:');
    for (const a of ARCHIVES) {
        const encPath = path.join(VAULT_DIR, a.enc);
        const srcExists = fs.existsSync(a.source);
        const encExists = fs.existsSync(encPath);
        const state = srcExists && encExists ? 'PLAIN + ARCHIVE' : srcExists ? 'PLAIN ONLY (not locked)' : encExists ? 'LOCKED (ciphertext only)' : '—';
        console.log(`  · ${path.relative(ROOT, a.source)} : ${state}`);
    }
    const rel = path.relative(ROOT, VAULT_DIR) || '.';
    console.log(`  · vault dir: ${rel}`);
    if (!process.env.VAULT_PASS) console.log('  · VAULT_PASS: not set (set it before lock/unlock)');
}

function doTest() {
    // Self-test lock -> wipe -> unlock roundtrip in a sandbox temp dir
    // (never touches the real .env or data/).
    const os = require('os');
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'kakuzu-vault-'));
    const pass = 'test-passphrase-1234';
    const key = getKey(pass);
    const target = path.join(t, '.env');
    const dataDir = path.join(t, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(target, 'DISCORD_TOKEN=abcdefghijklmnopqrstuvwxyz.123456.abcdefghijklmnopqrstuvwxyz\nSECRET=dummy\n');
    fs.writeFileSync(path.join(dataDir, 'raids.json'), '{"raids":[]}');
    fs.writeFileSync(path.join(dataDir, 'verification.sqlite'), Buffer.from([1, 2, 3, 4]));

    const envFile = path.join(t, 'env.enc');
    const dataFile = path.join(t, 'data.enc');
    const e1 = lockOne(key, target, envFile);
    verifyRestore(key, e1, target);
    const d1 = lockOne(key, dataDir, dataFile);
    verifyRestore(key, d1, dataDir);

    // Snapshot originals, then simulate a breach/wipe.
    const beforeEnv = fs.readFileSync(target);
    const beforeR = fs.readFileSync(path.join(dataDir, 'raids.json'));
    const beforeS = fs.readFileSync(path.join(dataDir, 'verification.sqlite'));
    fs.rmSync(target, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (fs.existsSync(target)) throw new Error('wipe failed');

    // "Undo" — restore from ciphertext.
    restoreDirFromBuffer(dataDir, JSON.parse(decryptBuffer(key, d1).toString('utf8')));
    fs.writeFileSync(target, decryptBuffer(key, e1));

    const afterEnv = fs.readFileSync(target);
    const afterR = fs.readFileSync(path.join(dataDir, 'raids.json'));
    const afterS = fs.readFileSync(path.join(dataDir, 'verification.sqlite'));
    if (!beforeEnv.equals(afterEnv)) throw new Error('env mismatch');
    if (!beforeR.equals(afterR)) throw new Error('raids mismatch');
    if (!beforeS.equals(afterS)) throw new Error('sqlite mismatch');
    fs.rmSync(t, { recursive: true, force: true });
    console.log('SELF-TEST PASSED: lock -> wipe -> unlock roundtrip restores byte-identical files.');
    console.log('(test ran in a temp dir; real .env and data/ were NOT touched)');
}

const cmd = process.argv[2] || 'status';
const wipe = process.argv.includes('--wipe');
try {
    if (cmd === 'lock') doLock(wipe);
    else if (cmd === 'unlock') doUnlock();
    else if (cmd === 'status') doStatus();
    else if (cmd === 'test') doTest();
    else {
        console.error('Usage: node tools/vault.js <lock|unlock|status|test> [--wipe]');
        process.exit(1);
    }
} catch (e) {
    console.error('Vault error:', e.message);
    if (e.message.includes('Unsupported state or unable to authenticate data')) {
        console.error('  — likely wrong VAULT_PASS or corrupted archive.');
    }
    process.exit(1);
}