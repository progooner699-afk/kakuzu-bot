# 🗺️ KAKUZU DISCORD BOT — LIVE DEVELOPMENT MAP

> **Read this first.** Any AI agent (or human) resuming work should start here for
> the current state, architecture, and how to run/verify the bot. It is updated
> continually as the project evolves.

## 📌 PROJECT STATUS

* **Status:** Stable — Recovery & Refactoring complete. All runtime files parse,
  test suite passes, and the working tree is committed & pushed to `origin/main`.
* **Framework:** Discord.js **v14** (`discord.js@^14.26.4`).
* **Database:** SQLite via **`sql.js`** (a pure-JS/wasm SQLite port — **NOT**
  `better-sqlite3`). Per-guild DB files at:
  `data/guilds/<guildId>/verification.sqlite` (created on demand).
  * Handle: `handlers/verificationDb.js` — exposes `isUserVerified`,
    `getVerificationData`, `markVerified`, `acceptVerification`,
    `rejectVerification`, `setVerificationLogMessage`,
    `getPendingVerifications`, `directLink`.
* **Backing store for raid/settings state:** `handlers/raidStateManager.js`
  (in-memory maps + per-guild JSON under `data/`). Also exposes
  `GAME_CONFIG`, `formatRaidMessage`, `formatTimeSpent`,
  `pollHelperPresences` (Roblox Presence API helper-time tracking).
* **HTTP dashboard:** Express + CORS on `process.env.PORT || 5000`
  (`index.js`) — `/` health, `/api/stats`, `/api/action/restart`, and the
  protected `GET /api/guilds/:guildId/roles` (bearer `BOT_API_TOKEN`). The roles
  route reads `guild.roles.cache` (no per-request Discord fetch), serves a 45s
  in-memory response cache, and is **never 429'd for authenticated callers**:
  bearer auth gates access, and cache-miss dedupe (per-guild single-flight +
  unknown-guild negative cache) caps Discord reads at one per guild per TTL.
  The old 300/min per-IP limiter caused shared-egress-IP dashboard users to get
  intermittent 429s and is no longer applied to this route.
* **Config/Secrets:** `config.json` (clientId), `.env` (`DISCORD_TOKEN`,
  optional `DATABASE_URL` for the shared Postgres ping config below).
  `.env` is git-ignored; `config.json` is committed.

## 🐘 SHARED POSTGRES — RAID PING CONFIGURATION (dashboard <-> bot)

> Only the **country/region raid ping** settings are shared with the separately
> deployed dashboard via one hosted PostgreSQL database. **Nothing else** was
> migrated: `raids.json`, `settings.json`, `verification.sqlite` and
> `leaderboard.sqlite` remain the bot's local source of truth.

* **Helper:** `handlers/sharedPingDb.js` — `pg` Pool built from `DATABASE_URL`
  (env var; never hard-coded, never logged). One async read:
  `getGuildPingSettings(guildId)` → `{ countryPings, regionPings }`; always
  resolves, never throws, returns empty maps when the DB is absent/down.
* **Table:** `guild_ping_settings (guild_id TEXT PK, country_pings JSONB,
  region_pings JSONB, updated_at TIMESTAMPTZ)` — created idempotently with
  `CREATE TABLE IF NOT EXISTS` on first use; the bot never DROPs/resets it.
* **SSL:** honors `?sslmode=` on `DATABASE_URL` or a `PGSSL` env override
  (`require|no-verify|prefer|allow` → `rejectUnauthorized:false`;
  `verify-full` → `rejectUnauthorized:true`).
* **Raid ping resolution** (`getRaidPingInfo` in `events/interactionCreate.js`):
  Country code takes precedence and is used ALONE — never both. If a
  `countryCode` was detected, only `countryPings[COUNTRY_CODE]` is considered;
  if that role is missing/deleted/invalid the alert posts with **no** location
  ping (no broad-region fallback). If no `countryCode` was detected, only
  `regionPings[BROAD_REGION]` is considered. If Postgres is unconfigured/down/
  empty the legacy `settings.regionPings` (from `/setregionping`) fallback runs,
  but only on the no-country region path. `allowedMentions.roles` restricts
  pings to exactly the chosen role. The alert embed shows the human-readable
  `Country` name (from `raidStateManager.countryCodeToName`, e.g. `IN` → `India`)
  directly under `Region`, or `Unknown` when undetected.
* **Detector:** `robloxApi.detectGameAndRegion` now also returns `countryCode`
  (ISO-3166 alpha-2, e.g. `SG`) alongside the broad `region` (e.g. `ASIA`);
  `regionMap.geolocateIp` returns `{ label, countryCode, ... }` and
  `resolveRoValraRegion` returns `{ region, countryCode }` best-effort. Region
  resolution uses **only** these two live services (RoValra first, then
  ip-api.com); if both fail the region is `Unknown` — no manual IP / data-center
  tables are consulted.
* **Transition:** `/setregionping` is intentionally UNTOUCHED for now (it still
  writes `settings.json`). A later stage removes it once the
  dashboard→Postgres→bot path is verified.
* **Running:** if `DATABASE_URL` is unset or empty, `sharedPingDb` returns empty
  maps and the legacy ping path runs — the bot needs zero Postgres changes.

## 🔁 IMPORTANT RECOVERY NOTE (as of latest commit)

The repo was **already clean & pushed** (`HEAD == origin/main`) at commit
`c0685c3` when this map was written. During the recovery session:

1. `events/interactionCreate.js` had a **brace imbalance** (one stray closing
   `}` in the step-1 block). It was re-validated: brace balance **344 open / 344
   close, diff 0**, and `node --check events\interactionCreate.js` → **exit 0**.
2. The raid report card had **mangled emoji** (lossy `?? MVP:` + `U+FFFD`
   replacement chars). Fixed to `🏆 MVP:` / `✅` / `⏱️ Time Spent`.
3. Files under `scripts/` are **disposable patch fragments** from the recovery —
   several do **not** parse on purpose (they are search/replace snippets). Ignore
   them; they are not runtime code and are git-ignored/stale.

## ✅ VERIFICATION PIPELINE REFACTOR (this commit)

Refactored the linking → request → join → close loop per the spec:

* **/link-roblox embed** uses a **green** (`ButtonStyle.Success`) `🔗 Link Roblox`
  button. The admin-selected channel is **persisted** per-guild as
  `settings.verificationChannel` so guard messages point users to the exact spot.
  Linking success replies `✅ Successfully linked as <name>!` (ephemeral; no
  pre-verification is required to link an account).
* **Unverified User Guard:** clicking `request_raid` or `Join` while unverified
  now replies an **ephemeral** `🔒 You are not verified! Please link your Roblox
  account in <#CHANNEL> first.` using the dynamically detected channel.
* **Public buttons are never greyed globally** for unverified users — the deny
  happens at interaction time, not via `setDisabled`.
* **Join delivery:** helpers receive an **ephemeral message with a native
  `ButtonStyle.Link` button** to an https Roblox "start" join URL. The requester's
  `placeId`/`serverId` are captured from Roblox presence and stored on the raid,
  and resolved by `buildRobloxJoinLink`.
* **Presence polling** lowered to **15s** (`PRESENCE_POLL_INTERVAL` in ready.js).
* **Auto-MVP:** on close/outcome the helper with the highest `timeSpentSeconds`
  is set as MVP automatically (manual picker removed).
* **Raid closure** restricted to the requester, Discord Administrator, the
  configured verification/admin roles, or the hardcoded names in
  `RAID_CLOSE_ROLES`.
* **Roblox API cleanup:** `handlers/robloxApi.js` had duplicated
  `validateAndGetAvatar` / `getUserPresence` / `detectGameAndRegion` (from
  overlapping edits). Deduplicated to single definitions; `detectGameAndRegion`
  now also returns `placeId` + `serverId`.

## ⚙️ PIPELINE ARCHITECTURE

1. **Roblox Linking / Verification (`/link-roblox`):**
   * Staff-only (Administrator **or** Manage Messages) command. Posts an
     embed + channel-select (`select_link_channel`) so an admin picks where the
     link embed goes; the chosen channel is persisted as
     `settings.verificationChannel`.
   * In that channel a **green** `🔗 Link Roblox` button (`link_roblox`) opens a
     modal (`link_roblox_modal`) → username validated via Roblox API
     (`handlers/robloxApi.js`) → `verificationDb.directLink(...)` grants raid
     access **immediately** (no moderator approval round-trip), then replies
     `✅ Successfully linked as <name>!` (ephemeral).
2. **Unverified Request/Accept handling:** If an unverified user clicks
   `request_raid` (or a `Join`), the bot replies **ephemeral** telling them to
   run `/link-roblox`. Public buttons are **never** greyed out for unverified
   users — the deny is an ephemeral message in the detected verification area.
3. **Automatic game, region & server-link detection:** `handlers/robloxApi.js`
   queries the Roblox Presence API (`presence.roblox.com`) for active
   `InGame` status → Place ID / Job ID / IP region (e.g., Mumbai, Frankfurt,
   Ashburn) to build the Roblox deep-link `roblox://experiences/start?...`.
4. **Active Raid Alert & Controls (`buildRaidAlertPayload` + `createRaidButtons`):**
   * The alert is now a **native Components V2 message** (message flag
     `1 << 15` / `IS_COMPONENTS_V2`). `handlers/raidV2.js` builds the payload
     from Text Display (`type: 10`) + **Separator (`type: 14`, `divider: true`)**,
     which renders the sleek native horizontal line between sections. Because
     V2 disables `content` + `embeds`, the region-role ping is sent as a
     separate message first, and the embed builder `formatRaidMessage` is kept
     purely as an automatic fallback.
   * Alert embed layout: `# 🚨 Raid Alert #<id>` title, ACTIVE subtitle with
     Discord `<t:...:F>` timestamp, requester avatar thumbnail, `###` sections
     (👤 Details / 🎯 Target / 🌐 Region / 👥 Helper Status / 💬 Description),
     code-blocked target & description, `Live Helpers (n/max)` with per-helper
     PFP lines, streak + region/ping line.
   * The embed fallback (`formatRaidMessage`) renders thin `─` `EMBED_DIVIDER`
     divider rows between the DETAILS / IN-GAME HELPERS / DESCRIPTION sections,
     plus the requester thumbnail via `setThumbnail`, so the separator line and
     thumbnail stay visible even when Discord rejects the native V2 payload
     (Components V2 is a Discord beta that must be granted to the bot; if not,
     the send fails and `/raidtest` reports "embed fallback"). Native
     `Separator` (`type: 14`) and `Thumbnail` (`type: 11`) components are still
     emitted by `handlers/raidV2.js` for when V2 is enabled.
   * V2 alert lifecycle: a successful V2 post sets `alertFormat: 'v2'` on the
     raid record (`raidV2.markAlertV2`); all later edits (accept / leave /
     close / outcome) branch on that flag and **edit `components` only** (no
     embeds), while historically posted alerts keep using the embed path.
     Every V2 edit **must pass `flags: raidV2.RAID_ALERT_V2_FLAGS`** (the
     IS_COMPONENTS_V2 flag must be kept on edit) and logs failures via
     `console.warn('[raid alert] V2 ... edit failed')` instead of a silent
     catch. The `👥 LIVE HELPERS` section is **always rendered** (even at
     0 helpers, showing `> • None yet — be the first to join!`) so the
     section never disappears from the alert.
   * `[ ↗️ JOIN SERVER ]` — `ButtonStyle.Link` (grey) to an https Roblox join URL
     (`https://www.roblox.com/games/start?placeId=...` — Discord Link buttons
     reject `roblox://` schemes, which would fail the whole alert), built by
     `buildRobloxJoinLink`.
   * `[ Join Raid ]` — `ButtonStyle.Secondary` (grey). On click by a verified
     helper, opens the accept modal; the helper is then sent an ephemeral native
     Discord **Link** button (`ButtonStyle.Link`) to the same deep-link.
   * `[ 🔒 CLOSE RAID ]` — `ButtonStyle.Secondary` (`close_raid_<id>`,
     handled alongside the legacy `raid_close_<id>`). Executable **only** by the
     raid requester or an authorized staff role (see `canCloseRaid`).
5. **Session Tracking & Results:**
   * `events/ready.js` starts a 15s interval → `raidStateManager.pollHelperPresences`
     tracks helper time. If no `ROBLOX_API_KEY` is set it no-ops and falls back
     to join→close delta.
   * On `[ Close Raid ]` → outcome picker (`raid_outcome_*`: Win / Whooped /
     Loss / Can't Say) → the helper with the most `timeSpentSeconds` is set as
     MVP automatically → raid closed, streak/metrics compiled, final Raid Result
     embed posted (see `buildReportCardEmbed` + outcome helpers starting ~line
     236).

## 📂 KEY FILES

| Path | Purpose |
| ---- | ------- |
| `index.js` | Bot bootstrap, intents, command loading, Express dashboard, `client.login`. |
| `events/ready.js` | On-ready guild command registration + helper-presence polling loop + sql.js verification DB pre-initialization. |
| `events/interactionCreate.js` | **Main interaction hub** (buttons, modals, selects). Contains verification decision helpers, link flow, raid application step 1, `open_raid_application` modal launcher, and the RAID OPERATIONS section (`raid_accept_`, `raid_leave_`, `raid_close_`, `raid_outcome_`, `raid_mvp_select_`). |
| `handlers/raidStateManager.js` | Raid CRUD + persistence + presence polling. |
| `handlers/raidV2.js` | Native Components V2 raid alert builder (`buildRaidAlertPayload`, `markAlertV2`). |
| `handlers/robloxApi.js` | Roblox API/Presence calls, username validation, deep-links. |
| `handlers/robloxAuth.js` | `.ROBLOSECURITY` handling: safe cookie-auth diagnostic that runs once at startup (`index.js`, `force`) and before each gamejoin (`getServerIp`); logs ONLY `cookieConfigured/cookieLength/authCheck/httpStatus/replacementCookieReceived` — never the value. In-memory rotation adoption on authenticated requests. |
| `handlers/verificationDb.js` | sql.js persistence for verification records. |
| `handlers/verificationHelpers.js` | `formatRobloxProfileValue` and friends. |
| `handlers/sharedPingDb.js` | Read-only shared PostgreSQL helper for dashboard-owned country/region ping settings (`getGuildPingSettings`). |
| `handlers/commandHandler.js` | Loads commands from `commands/` into `client.commands`. |
| `commands/deploy-commands.js` | `registerGuildCommands(guildId)` — used by `ready.js`; also a standalone CLI (`npm run deploy-commands`). |
| `commands/*.js` | Slash commands (link-roblox, requestraid, close-raid, channelconfig, setchannels, unsetchannels, setregionping, setlockedpingrole, botinfo, announcement, forceshutallraids, raidtest, etc.). |

## 🗑️ REMOVED COMMANDS (this session)

The following slash commands were removed (files deleted from `commands/`):

1. `/verification` (`commands/verification.js`) — verification portal embed
2. `/setverificationlogs` (`commands/setverificationlogs.js`) — set verification logs channel
3. `/setverificationresults` (`commands/setverificationresults.js`) — set verification results channel
4. `/verificationadminrole` (`commands/verificationadminrole.js`) — manage verification admin roles
5. `/verificationconfig` (`commands/verificationconfig.js`) — show verification configuration
6. `/verificationstatus` (`commands/verificationstatus.js`) — check user verification status

> **`/link-roblox` was NOT removed.** The verification *infrastructure* (handlers/
> `verificationDb.js`, `verificationHelpers.js`, the unverified-user guard, and the
> `verificationAdminRoles` setting in `interactionCreate.js`) is retained because
> `/link-roblox` uses it for direct-link auto-verification. `unsetchannels.js`
> help text was updated to remove references to the deleted set-commands.

## ✅ RECENT KEY DECISIONS (commit `c0685c3`)

* Removed the moderator "verification gate" — linking **auto-verifies** via
  `directLink`.
* Auto-verify on raid **accept** (helper modal writes a verification row).
* Fixed region detection; hide public Roblox links; button styling updates
  (grey secondary for Join / Close Raid).
* Fixed `/requestraid` interaction timeout: the `request_raid` button handler now
  calls `interaction.deferReply({ flags: 64 })` before the slow DB + Roblox API
  calls (sql.js init + `detectGameAndRegion`), then uses `editReply()` for errors
  and a follow-up `open_raid_application` button to launch the modal (Discord.js v14
  does not allow `showModal()` after deferring). sql.js verification DBs are
  pre-initialized in `ready.js` to keep on-demand queries fast.
* Fixed `gamejoin.roblox.com` "Unable to join Game 311" rejection: added
  `User-Agent` and `Referer` headers to the gamejoin API request in
  `handlers/robloxAuth.js`; Roblox's anti-automation checks now accept the request
  and return a valid `joinScript` with `MachineAddress`.

## 🧪 RUN & VERIFY

```bash
npm install
npm test                 # node --test  (suite: test/, plus scripts/require_test.js boot check)
node --check events\interactionCreate.js
npm run deploy-commands  # optional manual register
node index.js            # requires .env with DISCORD_TOKEN
```

## 📎 GIT

* Remote: `origin` → `https://github.com/progooner699-afk/kakuzu-bot.git`
* Branch: `main`.
* Keep `AGENTS.md` current whenever the architecture or running commands change,
  and keep `.gitignore` covering `.env`, `node_modules`, and stray `scripts/`.