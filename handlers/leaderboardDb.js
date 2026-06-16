const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(__dirname, '..', 'data', 'leaderboard.sqlite');
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
        CREATE TABLE IF NOT EXISTS leaderboard (
            userId TEXT PRIMARY KEY,
            raidCount INTEGER NOT NULL DEFAULT 0
        );
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS acceptedRaids (
            raidId INTEGER NOT NULL,
            userId TEXT NOT NULL,
            acceptedAt INTEGER NOT NULL,
            PRIMARY KEY (raidId, userId)
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

async function getRaidCount(userId) {
    const db = await getDb();
    const stmt = db.prepare('SELECT raidCount FROM leaderboard WHERE userId = ?');
    stmt.bind([userId]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? row.raidCount : 0;
}

async function incrementRaidCount(userId) {
    const db = await getDb();
    const stmt = db.prepare('INSERT INTO leaderboard (userId, raidCount) VALUES (?, 1) ON CONFLICT(userId) DO UPDATE SET raidCount = raidCount + 1');
    stmt.run([userId]);
    stmt.free();
    const count = await getRaidCount(userId);
    saveDb(db);
    return count;
}

async function hasAcceptedRaid(raidId, userId) {
    const db = await getDb();
    const stmt = db.prepare('SELECT 1 FROM acceptedRaids WHERE raidId = ? AND userId = ?');
    stmt.bind([raidId, userId]);
    const exists = stmt.step();
    stmt.free();
    return Boolean(exists);
}

async function markRaidAccepted(raidId, userId) {
    const db = await getDb();
    const stmt = db.prepare('INSERT OR IGNORE INTO acceptedRaids (raidId, userId, acceptedAt) VALUES (?, ?, ?)');
    stmt.run([raidId, userId, Date.now()]);
    stmt.free();
    saveDb(db);
}

async function getTopLeaderboard(limit = 15) {
    const db = await getDb();
    const stmt = db.prepare('SELECT userId, raidCount FROM leaderboard ORDER BY raidCount DESC, userId ASC LIMIT ?');
    stmt.bind([limit]);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

module.exports = {
    getRaidCount,
    incrementRaidCount,
    hasAcceptedRaid,
    markRaidAccepted,
    getTopLeaderboard
};
