/**
 * diagnose-cookie.js — standalone safe .ROBLOSECURITY diagnostic.
 *
 * Run locally (this PC) or on Render to compare environments:
 *   node diagnose-cookie.js
 *
 * Prints ONLY non-sensitive flags:
 *   cookieConfigured / cookieLength / authCheck / httpStatus /
 *   replacementCookieReceived
 * It NEVER prints, hashes or exposes any portion of BOT_ROBLOSECURITY.
 */
require('dotenv').config();
const { checkRobloxCookieAuth } = require('./handlers/robloxAuth');

(async () => {
  console.log('--- Roblox authenticated-cookie diagnostic (standalone) ---');
  const result = await checkRobloxCookieAuth('standalone', true);
  if (result.skipped) {
    console.log('[robloxAuth] diagnostic skipped by TTL throttle (unexpected in standalone mode)');
  }
  console.log(`--- RESULT: authCheck=${result.success ? 'success' : 'failure'} ---`);
})().catch((err) => {
  // Never print err.response bodies - they could echo request internals.
  console.log(`--- RESULT: authCheck=failure (${err && err.name ? err.name : 'Error'}) ---`);
});
