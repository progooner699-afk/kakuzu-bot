const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const baseDataDir = path.join(__dirname, '..', 'data');
const guildsDataDir = path.join(baseDataDir, 'guilds');
const dbCache = new Map();
let SQL;

function getGuildDbPath(guildId) {
    return path.join(guildsDataDir, guildId, 'verification.sqlite');
}

async function ensureDb(guildId) {
    if (!guildId) {
        throw new Error('Guild ID is required for verification database access.');
    }

    if (dbCache.has(guildId)) {
        return dbCache.get(guildId);
    }

    const dbPath = getGuildDbPath(guildId);
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const initSqlJsModule = await initSqlJs();
    SQL = initSqlJsModule;

    let db;
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS verifications (
            userId TEXT PRIMARY KEY,
            is_verified INTEGER NOT NULL DEFAULT 0,
            roblox_username TEXT,
            roblox_display_name TEXT,
            roblox_user_id TEXT,
            roblox_avatar_url TEXT,
            roblox_ps_link TEXT,
            kill_count TEXT,
            friend_list_link TEXT,
            verified_at INTEGER,
            status TEXT DEFAULT 'pending',
            rejection_reason TEXT,
            reviewed_by TEXT,
            reviewed_at INTEGER,
            log_channel_id TEXT,
            log_message_id TEXT,
            verification_id TEXT
        );
    `);

    try {
        db.run(`ALTER TABLE verifications ADD COLUMN log_channel_id TEXT`);
    } catch (error) {
        // Ignore if the column already exists
    }

    try {
        db.run(`ALTER TABLE verifications ADD COLUMN log_message_id TEXT`);
    } catch (error) {
        // Ignore if the column already exists
    }

    try {
        db.run(`ALTER TABLE verifications ADD COLUMN verification_id TEXT`);
    } catch (error) {
        // Ignore if the column already exists
    }
    saveDb(guildId, db);
    dbCache.set(guildId, db);
    return db;
}

function saveDb(guildId, db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(getGuildDbPath(guildId), buffer);
}

async function getDb(guildId) {
    return ensureDb(guildId);
}

async function isUserVerified(userId, guildId) {
    const db = await getDb(guildId);
    const stmt = db.prepare('SELECT is_verified FROM verifications WHERE userId = ?');
    stmt.bind([userId]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? Boolean(row.is_verified) : false;
}

async function getVerificationData(userId, guildId) {
    const db = await getDb(guildId);
    const stmt = db.prepare('SELECT * FROM verifications WHERE userId = ?');
    stmt.bind([userId]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row || null;
}

async function markVerified(userId, data, guildId) {
    const db = await getDb(guildId);
    const stmt = db.prepare(`
        INSERT INTO verifications (userId, is_verified, roblox_username, roblox_display_name, roblox_user_id, roblox_avatar_url, roblox_ps_link, kill_count, friend_list_link, verified_at, status, verification_id)
        VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(userId) DO UPDATE SET
            is_verified = 0,
            roblox_username = ?,
            roblox_display_name = ?,
            roblox_user_id = ?,
            roblox_avatar_url = ?,
            roblox_ps_link = ?,
            kill_count = ?,
            friend_list_link = ?,
            verified_at = ?,
            status = 'pending',
            rejection_reason = NULL,
            reviewed_by = NULL,
            reviewed_at = NULL,
            verification_id = ?
    `);
    const now = Date.now();
    const robloxDisplayName = data.robloxDisplayName || data.robloxUsername;
    const robloxUserId = data.robloxUserId || null;
    const robloxAvatarUrl = data.robloxAvatarUrl || null;
    const verificationId = data.verificationId || null;
    stmt.run([
        userId,
        data.robloxUsername, robloxDisplayName, robloxUserId, robloxAvatarUrl, data.robloxPsLink, data.killCount, data.friendListLink, now, verificationId,
        data.robloxUsername, robloxDisplayName, robloxUserId, robloxAvatarUrl, data.robloxPsLink, data.killCount, data.friendListLink, now, verificationId
    ]);
    stmt.free();
    saveDb(guildId, db);
    return true;
}

async function acceptVerification(userId, reviewerId, guildId) {
    const db = await getDb(guildId);
    const current = await getVerificationData(userId, guildId);
    if (!current) {
        return { success: false, code: 'NOT_FOUND', message: 'Verification request not found.' };
    }
    if (current.status !== 'pending') {
        return { success: false, code: 'ALREADY_PROCESSED', message: 'This verification request has already been processed.' };
    }
    const stmt = db.prepare(`
        UPDATE verifications SET
            is_verified = 1,
            status = 'accepted',
            reviewed_by = ?,
            reviewed_at = ?,
            rejection_reason = NULL
        WHERE userId = ? AND status = 'pending'
    `);
    stmt.run([reviewerId, Date.now(), userId]);
    const changes = db.getRowsModified();
    stmt.free();
    saveDb(guildId, db);
    if (changes > 0) {
        return { success: true, message: 'Verification accepted.' };
    }
    return { success: false, code: 'ALREADY_PROCESSED', message: 'This verification request has already been processed.' };
}

async function rejectVerification(userId, reviewerId, reason, guildId) {
    const db = await getDb(guildId);
    const current = await getVerificationData(userId, guildId);
    if (!current) {
        return { success: false, code: 'NOT_FOUND', message: 'Verification request not found.' };
    }
    if (current.status !== 'pending') {
        return { success: false, code: 'ALREADY_PROCESSED', message: 'This verification request has already been processed.' };
    }
    const stmt = db.prepare(`
        UPDATE verifications SET
            is_verified = 0,
            status = 'rejected',
            reviewed_by = ?,
            reviewed_at = ?,
            rejection_reason = ?
        WHERE userId = ? AND status = 'pending'
    `);
    stmt.run([reviewerId, Date.now(), reason, userId]);
    const changes = db.getRowsModified();
    stmt.free();
    saveDb(guildId, db);
    if (changes > 0) {
        return { success: true, message: 'Verification rejected.' };
    }
    return { success: false, code: 'ALREADY_PROCESSED', message: 'This verification request has already been processed.' };
}

async function setVerificationLogMessage(userId, channelId, messageId, guildId) {
    const db = await getDb(guildId);
    const stmt = db.prepare(`
        UPDATE verifications SET
            log_channel_id = ?,
            log_message_id = ?
        WHERE userId = ?
    `);
    stmt.run([channelId, messageId, userId]);
    stmt.free();
    saveDb(guildId, db);
    return true;
}

async function getPendingVerifications(guildId) {
    const db = await getDb(guildId);
    const stmt = db.prepare('SELECT * FROM verifications WHERE status = ?');
    stmt.bind(['pending']);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

module.exports = {
    isUserVerified,
    getVerificationData,
    markVerified,
    acceptVerification,
    rejectVerification,
    setVerificationLogMessage,
    getPendingVerifications
};