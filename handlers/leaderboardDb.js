const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const baseDataDir = path.join(__dirname, '..', 'data');
const guildsDataDir = path.join(baseDataDir, 'guilds');
const dbCache = new Map();
let SQL;

function getGuildDbPath(guildId) {
    return path.join(guildsDataDir, guildId, 'leaderboard.sqlite');
}

async function ensureDb(guildId) {
    if (!guildId) {
        throw new Error('Guild ID is required for leaderboard database access.');
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

    dbCache.set(guildId, db);
    saveDb(guildId, db);
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

async function incrementRaidCount(userId, guildId) {
    const db = await getDb(guildId);
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
    saveDb(guildId, db);
    return count;
}

async function markRaidAccepted(raidId, userId, guildId) {
    const db = await getDb(guildId);
    const stmt = db.prepare('INSERT OR IGNORE INTO raid_accepts (raidId, userId) VALUES (?, ?)');
    stmt.run([raidId, userId]);
    stmt.free();
    saveDb(guildId, db);
}

async function hasAcceptedRaid(raidId, userId, guildId) {
    const db = await getDb(guildId);
    const stmt = db.prepare('SELECT 1 FROM raid_accepts WHERE raidId = ? AND userId = ?');
    stmt.bind([raidId, userId]);
    const exists = stmt.step();
    stmt.free();
    return exists;
}

async function getTopLeaderboard(limit = 20, guildId) {
    const db = await getDb(guildId);
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