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
        CREATE TABLE IF NOT EXISTS raid_counts (
            userId TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        );
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS raid_accepts (
            raidId INTEGER NOT NULL,
            userId TEXT NOT NULL,
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

async function incrementRaidCount(userId) {
    const db = await getDb();
    const stmt = db.prepare('SELECT count FROM raid_counts WHERE userId = ?');
    stmt.bind([userId]);
    let count = 0;
    if (stmt.step()) {
        count = stmt.getAsObject().count;
    }
    stmt.free();
    count += 1;
    const upsert = db.prepare(`
        INSERT INTO raid_counts (userId, count) VALUES (?, ?)
        ON CONFLICT(userId) DO UPDATE SET count = ?
    `);
    upsert.run([userId, count, count]);
    upsert.free();
    saveDb(db);
    return count;
}

async function markRaidAccepted(raidId, userId) {
    const db = await getDb();
    const stmt = db.prepare('INSERT OR IGNORE INTO raid_accepts (raidId, userId) VALUES (?, ?)');
    stmt.run([raidId, userId]);
    stmt.free();
    saveDb(db);
}

async function hasAcceptedRaid(raidId, userId) {
    const db = await getDb();
    const stmt = db.prepare('SELECT 1 FROM raid_accepts WHERE raidId = ? AND userId = ?');
    stmt.bind([raidId, userId]);
    const exists = stmt.step();
    stmt.free();
    return exists;
}

async function getTopLeaderboard(limit = 20) {
    const db = await getDb();
    const stmt = db.prepare('SELECT userId, count as raidCount FROM raid_counts ORDER BY count DESC LIMIT ?');
    stmt.bind([limit]);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

module.exports = {
    incrementRaidCount,
    markRaidAccepted,
    hasAcceptedRaid,
    getTopLeaderboard
};