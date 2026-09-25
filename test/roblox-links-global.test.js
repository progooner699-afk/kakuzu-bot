const test = require('node:test');
const assert = require('node:assert/strict');

const sharedPingDb = require('../handlers/sharedPingDb');
const robloxLinks = require('../handlers/robloxLinks');

// In-memory Supabase fake: understands ONLY the kakuzu_roblox_links SQL the
// service issues. No production data touched; legacy sqlite never read here.
const linkRows = new Map();
let dbShouldFail = false;
sharedPingDb.isDatabaseConfigured = () => true;
sharedPingDb.runPoolQuery = async (sql, params = []) => {
  if (dbShouldFail) throw new Error('simulated database failure');
  const s = String(sql);
  if (/CREATE\s+(TABLE|INDEX)/i.test(s)) return { rows: [] };
  if (/ALTER TABLE kakuzu_roblox_links/i.test(s)) return { rows: [] };
  if (/INSERT INTO kakuzu_roblox_links/i.test(s)) {
    const [discordUserId, robloxUserId, robloxUsername, robloxDisplayName, robloxAvatarUrl] = params.map((v) => (v == null ? null : String(v)));
    for (const [otherId, row] of linkRows) {
      if (otherId !== discordUserId && String(row.roblox_user_id) === robloxUserId) {
        const err = new Error('duplicate key value violates unique constraint "uq_kakuzu_roblox_links_roblox_user_id"');
        err.code = '23505';
        throw err;
      }
    }
    const prev = linkRows.get(discordUserId);
    const now = new Date().toISOString();
    const row = {
      discord_user_id: discordUserId,
      roblox_user_id: robloxUserId,
      roblox_username: robloxUsername,
      roblox_display_name: robloxDisplayName,
      roblox_avatar_url: robloxAvatarUrl,
      verified: true,
      linked_at: prev ? prev.linked_at : now,
      updated_at: now,
    };
    linkRows.set(discordUserId, row);
    return { rows: [row] };
  }
  if (/DELETE FROM kakuzu_roblox_links/i.test(s)) {
    const id = String(params[0]);
    const had = linkRows.delete(id);
    return { rows: had ? [{ discord_user_id: id }] : [] };
  }
  if (/FROM kakuzu_roblox_links/i.test(s) && /WHERE discord_user_id = \$1/i.test(s)) {
    const row = linkRows.get(String(params[0]));
    return { rows: row ? [row] : [] };
  }
  if (/FROM kakuzu_roblox_links/i.test(s)) return { rows: [...linkRows.values()] };
  return { rows: [] };
};

test('global link: save then read across guilds (guild never in query)', async () => {
  robloxLinks.clearLinkCache();
  linkRows.clear();
  const saved = await robloxLinks.saveGlobalRobloxLink('discord-A', {
    robloxUserId: '1001', robloxUsername: 'Builderman', robloxDisplayName: 'Builder',
  });
  assert.equal(saved.discord_user_id, 'discord-A');
  assert.equal(saved.roblox_user_id, '1001');
  assert.equal(saved.verified, true);
  // Server A read
  const a = await robloxLinks.getGlobalRobloxLink('discord-A');
  assert.equal(a.ok, true);
  assert.equal(a.link.roblox_username, 'Builderman');
  // Server B read — same row, no second link needed
  const b = await robloxLinks.getGlobalRobloxLink('discord-A');
  assert.equal(b.ok, true);
  assert.equal(b.link.roblox_user_id, '1001');
});

test('unlinked user resolves to link:null (not unavailable)', async () => {
  robloxLinks.clearLinkCache();
  const res = await robloxLinks.getGlobalRobloxLink('ghost-user');
  assert.equal(res.ok, true);
  assert.equal(res.link, null);
});

test('cache clear reloads from Supabase (restart/deploy safe)', async () => {
  robloxLinks.clearLinkCache();
  const res = await robloxLinks.getGlobalRobloxLink('discord-A');
  assert.equal(res.ok, true);
  assert.equal(res.link.roblox_user_id, '1001');
});

test('DB outage is unavailable, never not-linked; cache kept', async () => {
  const before = await robloxLinks.getGlobalRobloxLink('discord-A');
  assert.equal(before.ok, true);
  dbShouldFail = true;
  try {
    const down = await robloxLinks.getGlobalRobloxLink('discord-A');
    assert.equal(down.ok, false);
    assert.equal(down.unavailable, true);
    assert.equal(down.link.roblox_user_id, '1001');
    const ghost = await robloxLinks.getGlobalRobloxLink('ghost-user');
    assert.equal(ghost.ok, false);
    assert.equal(ghost.unavailable, true);
    assert.equal(ghost.link, null);
  } finally {
    dbShouldFail = false;
  }
});

test('one Roblox account cannot overwrite another Discord user', async () => {
  await assert.rejects(
    robloxLinks.saveGlobalRobloxLink('discord-B', { robloxUserId: '1001', robloxUsername: 'Builderman' }),
    (err) => err && err.code === 'ROBLOX_ALREADY_LINKED' && /already linked to another Discord account/.test(err.message),
  );
  const kept = await robloxLinks.getGlobalRobloxLink('discord-B');
  assert.equal(kept.ok, true);
  assert.equal(kept.link, null);
});

test('relink updates the same global row; unlink removes it globally', async () => {
  const relinked = await robloxLinks.saveGlobalRobloxLink('discord-A', {
    robloxUserId: '2002', robloxUsername: 'Shedletsky',
  });
  assert.equal(relinked.roblox_user_id, '2002');
  const removed = await robloxLinks.removeGlobalRobloxLink('discord-A');
  assert.equal(removed, true);
  const gone = await robloxLinks.getGlobalRobloxLink('discord-A');
  assert.equal(gone.ok, true);
  assert.equal(gone.link, null);
});

test('separate Discord users keep separate Roblox accounts', async () => {
  await robloxLinks.saveGlobalRobloxLink('discord-A', { robloxUserId: '1001', robloxUsername: 'Builderman' });
  await robloxLinks.saveGlobalRobloxLink('discord-C', { robloxUserId: '3003', robloxUsername: 'Telamon' });
  const a = await robloxLinks.getGlobalRobloxLink('discord-A');
  const c = await robloxLinks.getGlobalRobloxLink('discord-C');
  assert.equal(a.link.roblox_user_id, '1001');
  assert.equal(c.link.roblox_user_id, '3003');
});

test('no secrets leak through sanitizeError', () => {
  const clean = sharedPingDb.sanitizeError(new Error('connect postgres://user:password123@host/db failed'));
  assert.ok(!clean.includes('password123'));
  assert.ok(!clean.includes('postgres://user'));
});
