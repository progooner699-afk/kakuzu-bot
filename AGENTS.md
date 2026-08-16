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
  (`index.js`) — `/` health, `/api/stats`, `/api/action/restart`.
* **Config/Secrets:** `config.json` (clientId), `.env` (`DISCORD_TOKEN`).
  `.env` is git-ignored; `config.json` is committed.

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
4. **Active Raid Alert & Controls (`formatRaidMessage` + `createRaidButtons`):**
   * Alert embed layout: `# 🚨 Raid Alert #<id>` title, ACTIVE subtitle with
     Discord `<t:...:F>` timestamp, requester avatar thumbnail, `###` sections
     (👤 Details / 🎯 Target / 🌐 Region / 👥 Helper Status / 💬 Description),
     code-blocked target & description, `Live Helpers (n/max)` with per-helper
     PFP lines, streak + region/ping line.
   * Sections are separated by a thin `─` divider line — a module-level
     `EMBED_DIVIDER` const (`'\u2500'.repeat(44)`) inside `formatRaidMessage`,
     inserted after the RAID ALERT banner, after DETAILS, after IN-GAME
     HELPERS, and under the `## LIVE HELPERS` heading.
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
| `events/ready.js` | On-ready guild command registration + helper-presence polling loop. |
| `events/interactionCreate.js` | **Main interaction hub** (buttons, modals, selects). Contains verification decision helpers, link flow, raid application step 1, and the RAID OPERATIONS section (`raid_accept_`, `raid_leave_`, `raid_close_`, `raid_outcome_`, `raid_mvp_select_`). |
| `handlers/raidStateManager.js` | Raid CRUD + persistence + presence polling. |
| `handlers/robloxApi.js` | Roblox API/Presence calls, username validation, deep-links. |
| `handlers/verificationDb.js` | sql.js persistence for verification records. |
| `handlers/verificationHelpers.js` | `formatRobloxProfileValue` and friends. |
| `handlers/commandHandler.js` | Loads commands from `commands/` into `client.commands`. |
| `commands/deploy-commands.js` | `registerGuildCommands(guildId)` — used by `ready.js`; also a standalone CLI (`npm run deploy-commands`). |
| `commands/*.js` | Slash commands (link-roblox, requestraid, verify-help, close-raid, channel config, setregionping, verificationadminrole, botinfo, announcement, forceshutallraids, etc.). |

## ✅ RECENT KEY DECISIONS (commit `c0685c3`)

* Removed the moderator "verification gate" — linking **auto-verifies** via
  `directLink`.
* Auto-verify on raid **accept** (helper modal writes a verification row).
* Fixed region detection; hide public Roblox links; button styling updates
  (grey secondary for Join / Close Raid).

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