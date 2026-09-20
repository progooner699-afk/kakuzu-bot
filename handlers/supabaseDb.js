const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

/*
 * supabaseDb.js — single shared Supabase Postgres connection.
 * Reuses the SAME pg Pool the raid-ping feature uses (DATABASE_URL), never opens
 * a second connection.  Supabase is the permanent source of truth; in-memory Maps
 * are caches only.
 *
 * Never log DATABASE_URL or any secret.  All migrations are ADDITIVE (CREATE IF
 * NOT EXISTS / ADD COLUMN IF NOT EXISTS).  No DROP, no TRUNCATE.
 */
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_HISTORY_TABLE = 'kakuzu_migration_history';

function buildPool() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.warn('[supabaseDb] DATABASE_URL is not set — Supabase features will be no-ops. Set DATABASE_URL in the Render environment (never commit it).');
        return null;
    }
    const ssl = buildSslConfig(url);
    try {
        return new Pool({ connectionString: url, ssl });
    } catch (err) {
        console.error('[supabaseDb] Failed to create pg Pool:', (err && err.message) || err);
        return null;
    }
}

function buildSslConfig(connectionString) {
    let sslMode = 'prefer';
    const sslModeMatch = connectionString.match(/[?&]sslmode=([^&;]+)/i);
    if (sslModeMatch) {
        sslMode = sslModeMatch[1];
    } else if (process.env.PGSSL) {
        sslMode = process.env.PGSSL;
    }
    const normalized = sslMode.toLowerCase();
    if (normalized === 'require' || normalized === 'no-verify' || normalized === 'prefer' || normalized === 'allow') {
        return { rejectUnauthorized: false };
    }
    if (normalized === 'verify-full') {
        return { rejectUnauthorized: true };
    }
    return {};
}

const pool = buildPool();

async function runQuery(sql, params, timeoutMs) {
    if (!pool) {
        const msg = 'Supabase pool is not configured (DATABASE_URL missing).';
        console.warn('[supabaseDb] ' + msg);
        throw new Error(msg);
    }
    const deadline = (timeoutMs && timeoutMs > 0) ? timeoutMs : 8000;
    const client = await pool.connect();
    try {
        const result = await Promise.race([
            client.query(sql, params || []),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Query timed out after ' + deadline + 'ms')), deadline))
        ]);
        return result;
    } finally {
        client.release();
    }
}

async function queryOne(sql, params, timeoutMs) {
    const result = await runQuery(sql, params, timeoutMs);
    if (!result || !result.rows || result.rows.length === 0) return null;
    return result.rows[0];
}

async function queryAll(sql, params, timeoutMs) {
    const result = await runQuery(sql, params, timeoutMs);
    if (!result || !result.rows) return [];
    return result.rows;
}

async function queryValue(sql, params, timeoutMs) {
    const row = await queryOne(sql, params, timeoutMs);
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length > 0 ? row[keys[0]] : null;
}

module.exports = {
    runQuery,
    queryOne,
    queryAll,
    queryValue,
    pool,
    isConfigured: () => pool != null,
    MIGRATIONS_DIR,
};

/*
 * Migration system.
 * Creates kakuzu_migration_history (migration_id TEXT PK, applied_at TIMESTAMPTZ)
 * and applies every .sql file in migrations/ that has not been applied yet, in
 * filename order.  Safe to call many times — already-applied migrations are skipped.
 */
async function ensureMigrationHistoryTable() {
    await runQuery(
        `CREATE TABLE IF NOT EXISTS ` + MIGRATION_HISTORY_TABLE + ` (
            migration_id TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
    );
}

async function getAppliedMigrations() {
    const rows = await queryAll(
        `SELECT migration_id FROM ` + MIGRATION_HISTORY_TABLE + ` ORDER BY migration_id`
    );
    return new Set(rows.map(r => r.migration_id));
}

async function markMigrationApplied(migrationId) {
    await runQuery(
        `INSERT INTO ` + MIGRATION_HISTORY_TABLE + ` (migration_id) VALUES ($1)
         ON CONFLICT (migration_id) DO NOTHING`,
        [migrationId]
    );
}

async function listMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    const entries = fs.readdirSync(MIGRATIONS_DIR);
    return entries
        .filter(f => f.endsWith('.sql'))
        .map(f => ({ id: f.replace(/\.sql$/, ''), path: path.join(MIGRATIONS_DIR, f) }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

async function runPendingMigrations() {
    await ensureMigrationHistoryTable();
    const applied = await getAppliedMigrations();
    const files = await listMigrationFiles();
    for (const file of files) {
        if (applied.has(file.id)) continue;
        console.info('[supabaseDb] Applying migration:', file.id);
        const sql = fs.readFileSync(file.path, 'utf8');
        await runQuery(sql);
        await markMigrationApplied(file.id);
        console.info('[supabaseDb] Migration applied:', file.id);
    }
}

/*
 * Idempotent table init (CREATE IF NOT EXISTS).  Safe to call many times.
 * These are used by feature code that needs a table to exist right now without
 * going through the full migration runner.
 */
async function initRobloxLinksTable() {
    await runQuery(`CREATE TABLE IF NOT EXISTS kakuzu_roblox_links (
        discord_user_id TEXT PRIMARY KEY,
        roblox_user_id TEXT NOT NULL,
        roblox_username TEXT NOT NULL,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_roblox_links_roblox_user_id
        ON kakuzu_roblox_links (roblox_user_id)`);
}

async function initRaidChannelsTable() {
    await runQuery(`CREATE TABLE IF NOT EXISTS kakuzu_raid_channels (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function initRaidsTable() {
    await runQuery(`CREATE TABLE IF NOT EXISTS kakuzu_raids (
        raid_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        display_number INTEGER NOT NULL,
        requester_id TEXT NOT NULL,
        target_game TEXT,
        place_id TEXT,
        server_id TEXT,
        enemy_clan_names TEXT,
        enemy_names TEXT,
        region TEXT,
        country_code TEXT,
        reason TEXT,
        helper_limit INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING','OPEN','FULL','CLOSED')),
        outcome TEXT
            CHECK (outcome IS NULL OR outcome IN ('win','whooped','loss','noresult')),
        mvp_user_id TEXT,
        result_channel_id TEXT,
        raid_message_id TEXT,
        alert_channel_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
    )`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_raids_guild_display
        ON kakuzu_raids (guild_id, display_number)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_raids_requester
        ON kakuzu_raids (requester_id)`);
}

module.exports = Object.assign(module.exports, {
    ensureMigrationHistoryTable,
    getAppliedMigrations,
    markMigrationApplied,
    listMigrationFiles,
    runPendingMigrations,
    initRobloxLinksTable,
    initRaidChannelsTable,
    initRaidsTable,
});

