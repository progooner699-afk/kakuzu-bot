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
  Country code takes precedence — when a `countryCode` is detected the
  country role (`countryPings[COUNTRY_CODE]`) is tried first; if it is not
  configured or the role no longer exists in the guild, the bot **falls
  back** to the broad region role (`regionPings[BROAD_REGION]`) so that
  region-only dashboard configs still produce a location ping. If no
  `countryCode` was detected, only the region role is considered. Lookups
  are **case-insensitive** (so a dashboard storing "in"/"asia" matches the
  bot's "IN"/"ASIA"); role IDs from JSONB are coerced to strings. Config
  comes **exclusively** from the shared Postgres dashboard
  (`getGuildPingSettings`); the legacy `settings.regionPings` (from the
  removed `/setregionping` command) is no longer read — if the DB is
  unconfigured/down/empty there is simply **no** location ping on either
  path. `allowedMentions.roles` restricts pings to exactly the chosen role.
  The alert embed shows the human-readable `Country` name (from
  `raidStateManager.countryCodeToName`, e.g. `IN` → `India`) directly under
  `Region`, or `Unknown` when undetected.
* **Detector:** `robloxApi.detectGameAndRegion` now also returns `countryCode`
  (ISO-3166 alpha-2, e.g. `SG`) alongside the broad `region` (e.g. `ASIA`),
  plus `regionLabel` (human-readable "City, Country") and `regionSource`
  ('RoValra' | 'ip-api'). Region/country resolution is a strict two-step
  fallback chain in `handlers/regionMap.js`:
  1. **RoValra FIRST** — `resolveRoValraDatacenterRegion(dataCenterId)` fetches
     RoValra's public Roblox datacenter list
     (`https://apis.rovalra.com/v1/datacenters/list`, cached 1h, 8s timeout)
     and looks up the gamejoin API's `DataCenterId` → exact
     `{ city, region, country (ISO-2), country_name }`. No IP guessing.
  2. **ip-api.com FALLBACK** — `geolocateIp(publicAddress || machineAddress)`
     (4s timeout) only when RoValra has no hit / fails; the country name or
     ISO code is normalized to the bot's region set.
  If both fail the region is `Unknown`. The old invented
  `GET /v1/geolocation?ip=` endpoint returned 404 for every IP and was removed.
* **Presence AUTO-JOIN (`handlers/autoJoinPresence.js`):** the 15s loop in
  `events/ready.js` also runs `pollAutoJoin(client, guildId)` per guild. It
  reads every LINKED (verified) user via `verificationDb.getAllVerifiedUsers`,
  polls the Roblox Presence API (needs `ROBLOX_API_KEY`; no-ops without it),
  and any linked user whose presence is `InGame` (`userPresenceType === 2`)
  in the SAME experience (`placeId` match) as an OPEN raid is auto-added via
  `raidStateManager.addHelper` and the alert message is re-rendered
  (`updateAlertMessage`) so the LIVE HELPERS section updates with no button
  click. Users already helping/requesting are excluded. NOTE: presence only
  exposes `placeId` (not the server job id), so matching is per-experience.
  `pollHelperPresences` time-tracking was fixed to compare `userPresenceType`
  against the integer `2` (the old `'InGame'` string comparison never matched).
* **Join modal hardening:** the `raid_acceptmodal_` handler now defers the
  interaction BEFORE the Roblox validation + sql.js writes (3s Discord timeout
  used to silently kill the flow), wraps the flow in try/catch with a visible
  ephemeral error, and uses `editReply` throughout. `createRaidButtons` is
  exported from `events/interactionCreate.js` for reuse by the auto-join
  alert re-render.
* **Removed `/setregionping`:** the legacy settings.json `regionPings` command was
  deleted — the dashboard→Postgres→bot path is now the SOLE source of truth.
* **Running:** if `DATABASE_URL` is unset or empty, `sharedPingDb` logs a one-time
  warning and returns empty maps — the bot simply posts with **no** location ping.
  Set `DATABASE_URL` in your environment for dashboard pings to work.

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

1. **Roblox Linking / Verification (the `/backuppanel` panel):**
   * `/backuppanel` (Manage Server only) posts the branded Components V2 panel
     through a webhook named `backuppanel` (dummy profile). Posting it persists
     the chosen channel as `settings.verificationChannel` (via the
     `post_backuppanel` handler), so guard messages point at the panel.
   * The panel's **"Link Roblox account"** button (`link_roblox`) opens a
     modal (`link_roblox_modal`) → username validated via Roblox API
     (`handlers/robloxApi.js`) → `verificationDb.directLink(...)` grants raid
     access **immediately** (no moderator approval round-trip), then replies
     `✅ Successfully linked as <name>!` (ephemeral).
2. **Unverified Request/Accept handling:** If an unverified user clicks
   `request_backup` (or a `Join`), the bot replies **ephemeral** pointing them
   to the backup-panel channel to link their Roblox account. Public buttons are
   **never** greyed out for unverified
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
     the send falls back to embeds). Native
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
     Loss / **No Result** — the old "Can't Say" option was REMOVED). For
     Win/Whooped/Loss the helper with the most `timeSpentSeconds` is set as
     MVP automatically → raid closed, streak/metrics compiled, and the final
     Raid Result is posted as a **native Components V2 card** built by
     `handlers/raidResultCard.js` (`buildResultCardPayload`),
     with the region-role ping sent as a separate message first (V2 disables
     `content`); if the V2 send fails it falls back to a classic embed
     (`buildResultFallbackEmbed`). The **3 card types** share one layout with
     different title emojis: Win `🏆 RAID WON <:won:…>` , Whooped `💀 RAID
     WHOOPED`, Loss `❌ RAID LOST` (emoji map:
     `raidResultCard.OUTCOME_STYLES`).
   * **Rally picture / proof upload flow:** closing a result outcome creates a
     temporary `raid-uploads-<id>` channel (2 min window). The closer sends
     their **rally picture** then types `rally` — it becomes the TOP banner of
     the result card (`rallyPicUrl`; prefers the picture in the same message,
     else pops the most recently uploaded URL; falls back to the default
     banner when unset). Remaining pictures are collected as **Raid Proof**
     (rendered as clickable `[Image n](url)` text links, never gallery items).
     Typing `done` closes the channel and posts the card.
   * **No Result option:** `raid_outcome_nolog_<id>` closes the raid WITHOUT a
     result card, streaks or metrics, skips the upload channel entirely, and
     posts a simple "🚫 NO RAID RESULTS RECORDED" note embed
     (`buildNoResultEmbed`) to the configured result channel.

## 📂 KEY FILES

| Path | Purpose |
| ---- | ------- |
| `index.js` | Bot bootstrap, intents, command loading, Express dashboard, `client.login`. |
| `events/ready.js` | On-ready guild command registration + helper-presence polling loop + sql.js verification DB pre-initialization. |
| `events/interactionCreate.js` | **Main interaction hub** (buttons, modals, selects). Contains verification decision helpers, link flow, raid application step 1, `open_raid_application` modal launcher, and the RAID OPERATIONS section (`raid_accept_`, `raid_leave_`, `raid_close_`, `raid_outcome_`, `raid_mvp_select_`). |
| `handlers/raidStateManager.js` | Raid CRUD + persistence + presence polling. |
| `handlers/raidV2.js` | Native Components V2 raid alert builder (`buildRaidAlertPayload`, `markAlertV2`). |
| `handlers/raidResultCard.js` | Native Components V2 raid RESULT card: `buildResultCardPayload` (win/whooped/loss title styles, rally-pic TOP banner), `buildResultFallbackEmbed` (classic-embed fallback), `buildNoResultEmbed` (🚫 No Result note). |
| `handlers/robloxApi.js` | Roblox API/Presence calls, username validation, deep-links. |
| `handlers/robloxAuth.js` | `.ROBLOSECURITY` handling: safe cookie-auth diagnostic that runs once at startup (`index.js`, `force`) and before each gamejoin (`getServerIp`); logs ONLY `cookieConfigured/cookieLength/authCheck/httpStatus/replacementCookieReceived` — never the value. In-memory rotation adoption on authenticated requests. |
| `handlers/verificationDb.js` | sql.js persistence for verification records. |
| `handlers/verificationHelpers.js` | `formatRobloxProfileValue` and friends. |
| `handlers/sharedPingDb.js` | Read-only shared PostgreSQL helper for dashboard-owned country/region ping settings (`getGuildPingSettings`). |
| `handlers/commandHandler.js` | Loads commands from `commands/` into `client.commands`. |
| `commands/deploy-commands.js` | `registerGuildCommands(guildId)` — used by `ready.js`; also a standalone CLI (`npm run deploy-commands`). |
| `commands/announcement.js` | **Interactive Components V2 announcement builder** (`/announcement`, Manage Messages): ephemeral builder panel (Title / Description / **Thumbnail upload collector** / **Webhook Icon upload collector** / **Color** / Ping / **Webhook name** / **Field 1-8** / Clear Fields / Preview / Publish / Cancel). Up to **8 fields**, each separated by a native V2 `Separator` (`type: 14`). The thumbnail is a **wide full-width MediaGallery (`type: 12`) TOP banner**. The **Color** modal (hex) sets the Container accent bar — the vertical "embed line". The **Icon** collector stores the image bytes and applies them as the webhook avatar on publish; when no icon is chosen, a bundled `assets/transparent-avatar.png` (a 1x1 fully-transparent PNG) is applied so Discord's grey default icon stays **invisible**. Publishing asks for a target channel, then finds/creates a **webhook with the user-typed name** in that channel and posts the V2 card through it (the ping, if set, is sent as a separate message first because the V2 flag disables `content`). Exposes `buildAnnouncementPayload`, `buildBuilderComponents`, `handleAnnouncementComponent`, `getInvisibleAvatarBuffer`, `ANNOUNCEMENT_V2_FLAGS`, `MAX_FIELDS`, `DEFAULT_ACCENT_COLOR`; wired into `events/interactionCreate.js` via an early `annb_` customId dispatch. |
| `commands/*.js` | Slash commands (backuppanel, close-raid, setchannels, unsetchannels, setlockedpingrole, botinfo, announcement, forceshutallraids, etc.). |

## 🗑️ REMOVED COMMANDS (this session)

The following slash commands were removed (files deleted from `commands/`):

1. `/verification` (`commands/verification.js`) — verification portal embed
2. `/setverificationlogs` (`commands/setverificationlogs.js`) — set verification logs channel
3. `/setverificationresults` (`commands/setverificationresults.js`) — set verification results channel
4. `/verificationadminrole` (`commands/verificationadminrole.js`) — manage verification admin roles
5. `/verificationconfig` (`commands/verificationconfig.js`) — show verification configuration
6. `/verificationstatus` (`commands/verificationstatus.js`) — check user verification status
7. `/requestraid` (`commands/requestraid.js`) — old rules-embed + `request_raid`
   button panel. Its raid-request **flow** lives on: the `request_backup` button
   on the `/backuppanel` panel runs the exact same handler (the legacy
   `request_raid` customId is still accepted so old posted panels don't break).
8. `/link-roblox` (`commands/link-roblox.js`) — link-embed setup command. Its
   linking **flow** lives on via the backuppanel's `link_roblox` button →
   `link_roblox_modal` → `directLink`. The dead `select_link_channel` handler
   was removed from `events/interactionCreate.js`, and `settings.verificationChannel`
   is now persisted when the backup panel is posted (post_backuppanel handler).
   The `test/link-roblox-command.test.js` test file was deleted with it.
9. `/setregionping` (`commands/setregionping.js`) — configure region ping roles
   (`settings.regionPings`). REMOVED — region/country pings are now set from the
   separate dashboard via shared Postgres. The legacy `settings.regionPings`
   fallback in `getRaidPingInfo` (and the `regionPings` default in
   `handlers/raidStateManager.js`) was removed with it; with no DB config there
   is simply no location ping.
10. `/rwinner` (`commands/rwinner.js`) — static test result card. REMOVED — the
    live close-flow result card built by `handlers/raidResultCard.js` is the
    production path now.
11. `/channelconfig` (`commands/channelconfig.js`) — show configured channels.
    REMOVED.
12. `/raidtest` (`commands/raidtest.js`) — fake raid alert test embed. REMOVED —
    testing is complete (the `/raidtest` auto-detection reference in the
    `handlers/raidV2.js` thumbnail resolver was updated too).

> The verification *infrastructure* (handlers/
> `verificationDb.js`, `verificationHelpers.js`, the unverified-user guard, and the
> `verificationAdminRoles` setting in `interactionCreate.js`) is retained because
> the backuppanel link button uses it for direct-link auto-verification.

## ✅ RECENT KEY DECISIONS (commit `c0685c3`)

* **Per-Roblox-server raid numbering:** the raid alert / Raid ID / raid count now
  count **per Roblox game-server** (`raid.serverIndex`): each `serverId` gets its own
  `#1, #2, ...` sequence, so a raid in Roblox server A shows #1 while a raid
  in server B also starts at #1. The unique internal `raidId` stays guild-wide for
  lookups, leaderboard keys (raid_accepts）, button customIds and channel names（`raid-alert-<id>`,`raid-uploads-<id>`）。 `getRaidDisplayId(raid)` returns the display number (falls back to raidId for legacy raids保存 before per-server counting（.
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