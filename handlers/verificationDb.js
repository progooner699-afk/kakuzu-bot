const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(__dirname, '..', 'data', 'verification.sqlite');
let dbPromise;
let SQL;

async function ensureDb() {
    if (dbPromise) return dbPromise;
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const initSqlJsModule = await initSqlJs();
    SQL = initSqlJsModule;

    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        dbPromise = Promise.resolve(new SQL.Database(fileBuffer));
    } else {
        const db = new SQL.Database();
        dbPromise = Promise.resolve(db);
    }

    const db = await dbPromise;
    db.run(`
        CREATE TABLE IF NOT EXISTS verifications (
            userId TEXT PRIMARY KEY,
            is_verified INTEGER NOT NULL DEFAULT 0,
            roblox_username TEXT,
            roblox_ps_link TEXT,
            kill_count TEXT,
            friend_list_link TEXT,
            verified_at INTEGER
        );
    `);
    saveDb(db);
    return db;
}

function saveDb(db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}

async function getDb() {
    return ensureDb();
}

async function isUserVerified(userId) {
    const db = await getDb();
    const stmt = db.prepare('SELECT is_verified FROM verifications WHERE userId = ?');
    stmt.bind([userId]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? Boolean(row.is_verified) : false;
}

async function getVerificationData(userId) {
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM verifications WHERE userId = ?');
    stmt.bind([userId]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row || null;
}

async function markVerified(userId, data) {
    const db = await getDb();
    const stmt = db.prepare(`
        INSERT INTO verifications (userId, is_verified, roblox_username, roblox_ps_link, kill_count, friend_list_link, verified_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
            is_verified = 1,
            roblox_username = ?,
            roblox_ps_link = ?,
            kill_count = ?,
            friend_list_link = ?,
            verified_at = ?
    `);
    const now = Date.now();
    stmt.run([
        userId,
        data.robloxUsername, data.robloxPsLink, data.killCount, data.friendListLink, now,
        data.robloxUsername, data.robloxPsLink, data.killCount, data.friendListLink, now
    ]);
    stmt.free();
    saveDb(db);
    return true;
}

module.exports = {
    isUserVerified,
    getVerificationData,
    markVerified
};