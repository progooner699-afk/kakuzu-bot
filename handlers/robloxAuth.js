'use strict';

// ---------------------------------------------------------------------------
// Safe authenticated-cookie diagnostics & rotation handling (.ROBLOSECURITY).
//
// HARD RULES (do not violate when editing this file):
//   - NEVER log, hash, echo, truncate-print or otherwise expose ANY portion of
//     BOT_ROBLOSECURITY. Diagnostics may report only boolean flags + lengths.
//   - Cookie rotation: Roblox can rotate .ROBLOSECURITY and return the new
//     value via a Set-Cookie header. Per Roblox's guidance, hard-coded external
//     bots must respect these updates or start receiving 401s. When a request
//     AUTHENTICATES successfully and Roblox returns a replacement
//     .ROBLOSECURITY, we adopt it IN MEMORY ONLY for all later requests in
//     this process. It is never persisted and never logged.
// ---------------------------------------------------------------------------

let botCookie = process.env.BOT_ROBLOSECURITY || '';

/**
 * Inspects a fetch Response's Set-Cookie headers for a replacement
 * .ROBLOSECURITY value. Never logs the value.
 * @param {Response} res
 * @returns {{received: boolean, value: string|null}}
 */
function extractReplacementSecurityCookie(res) {
    const out = { received: false, value: null };
    try {
        const cookies = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [];
        for (const raw of cookies) {
            const m = /^\.ROBLOSECURITY=([^;]+)/i.exec(raw);
            if (m && m[1]) {
                out.received = true;
                out.value = m[1];
                break;
            }
        }
    } catch (_) { /* header inspection is best-effort */ }
    return out;
}

/**
 * Adopts an in-memory rotated cookie, but ONLY when the request it arrived on
 * was verifiably authenticated (a failed auth can return a fresh ANONYMOUS
 * guest .ROBLOSECURITY - adopting that would break all subsequent calls).
 * @param {{received: boolean, value: string|null}} replacement
 * @param {boolean} authenticated
 */
function adoptReplacementCookieIfAuthenticated(replacement, authenticated) {
    if (authenticated && replacement.received && replacement.value) {
        try { botCookie = decodeURIComponent(replacement.value); }
        catch (_) { botCookie = replacement.value; } // value is NEVER logged
        console.log('[robloxAuth] rotated .ROBLOSECURITY adopted in memory from Set-Cookie (value never logged).');
    }
}

// Throttle: presence polling can reach gamejoin paths frequently; run the real
// HTTP auth probe at most once per TTL so logs stay readable and Roblox sees no
// extra traffic beyond one probe per window.
const COOKIE_DIAG_TTL_MS = 10 * 60 * 1000;
let lastCookieDiagAt = 0;

/**
 * Safe authenticated-cookie diagnostic against Roblox's authenticated-user
 * endpoint. Logs ONLY:
 *   cookieConfigured, cookieLength, authCheck, httpStatus,
 *   replacementCookieReceived
 * and nothing else about the cookie.
 * @param {string} [context] short label, e.g. 'pre-gamejoin' | 'standalone'
 * @param {boolean} [force] bypass the TTL throttle (used by standalone script)
 * @returns {Promise<{success: boolean, skipped?: boolean}>}
 */
async function checkRobloxCookieAuth(context, force) {
    const now = Date.now();
    if (!force && now - lastCookieDiagAt < COOKIE_DIAG_TTL_MS) {
        return { success: true, skipped: true };
    }
    lastCookieDiagAt = now;

    const label = context ? ` (${context})` : '';
    if (!botCookie) {
        console.log(`[robloxAuth]${label} cookie diagnostic: cookieConfigured=false cookieLength=0 authCheck=failure httpStatus=null replacementCookieReceived=false`);
        return { success: false };
    }

    let httpStatus = null;
    let replacementCookieReceived = false;
    let success = false;
    try {
        const res = await fetch('https://users.roblox.com/v1/users/authenticated', {
            headers: {
                'Cookie': `.ROBLOSECURITY=${botCookie}`,
                'User-Agent': 'Roblox/WinInet'
            }
        });
        httpStatus = res.status;
        const replacement = extractReplacementSecurityCookie(res);
        replacementCookieReceived = replacement.received;
        let authenticated = false;
        if (res.ok) {
            try {
                const body = await res.json();
                authenticated = Boolean(body && body.id);
            } catch (_) { /* treat as unauthenticated */ }
        }
        success = authenticated;
        adoptReplacementCookieIfAuthenticated(replacement, authenticated);
    } catch (_) {
        success = false; // network failure - do not surface internals
    }

    console.log(`[robloxAuth]${label} cookie diagnostic: cookieConfigured=true cookieLength=${String(botCookie).length} authCheck=${success ? 'success' : 'failure'} httpStatus=${httpStatus} replacementCookieReceived=${replacementCookieReceived}`);
    return { success };
}

async function getCsrfToken() {
  const res = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST',
    headers: { Cookie: `.ROBLOSECURITY=${botCookie}` }
  });
  return res.headers.get('x-csrf-token');
}

/**
 * Resolves a Roblox placeId + serverId into the game instance's IP and data
 * center via the gamejoin API. Returns { machineAddress, publicAddress,
 * dataCenterId } when Roblox hands back a joinScript, otherwise returns null
 * (see logGameJoinAttempt for the safe diagnostics emitted on every attempt).
 * `publicAddress` is extracted from
 * `UdmuxEndpoints[0].Address` (the public-facing IP) or null if unavailable.
 * Diagnostics are safe: each attempt logs only whitelisted flags (httpStatus,
 * joinScript presence, response status/statusMessage, queuePosition, Roblox
 * error code/subcode/message, csrfPresent bool, replacementCookieReceived).
 * Machine addresses, public addresses/IPs, cookies, CSRF tokens, Authorization
 * headers and secrets are NEVER logged.
 * @param {string|number} placeId
 * @param {string} serverId - the server instance's jobId / gameInstanceGuid
 * @returns {Promise<{machineAddress: string, publicAddress: string|null, dataCenterId: string}|null>}
 */
async function getServerIp(placeId, serverId) {
  // Safe authenticated-cookie diagnostic BEFORE any gamejoin attempt.
  await checkRobloxCookieAuth('pre-gamejoin');

  async function attemptJoin(attempt) {
    const csrfToken = await getCsrfToken();
    const csrfPresent = Boolean(csrfToken); // token value is NEVER logged
    const res = await fetch('https://gamejoin.roblox.com/v1/join-game-instance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `.ROBLOSECURITY=${botCookie}`,
        'X-CSRF-TOKEN': csrfToken,
        'User-Agent': 'Roblox/WinInet',
        'Referer': 'https://www.roblox.com/games/' + placeId
      },
      body: JSON.stringify({
        placeId: placeId,
        isTeleport: false,
        gameId: serverId,
        gameJoinAttemptId: serverId
      })
    });
    // Respect cookie rotation: capture any replacement .ROBLOSECURITY offered
    // via Set-Cookie. It is adopted ONLY when this join authenticated (a
    // joinScript came back); the value itself is never logged.
    const replacement = extractReplacementSecurityCookie(res);
    let response;
    try { response = await res.json(); } catch (_) { response = {}; }

    // No behavioral change: rotation still requires a real joinScript.
    if (response && response.joinScript) {
      adoptReplacementCookieIfAuthenticated(replacement, true);
    }

    // Safe whitelisted per-attempt diagnostic (no raw body / secrets / IPs).
    logGameJoinAttempt({
      attempt,
      httpStatus: res.status,
      csrfPresent,
      replacementReceived: replacement.received,
      response
    });

    return response || {};
  }

  let response = await attemptJoin(1);
  let retries = 0;

  while (!response.joinScript && response.status === 22 && retries < 8) {
    await new Promise(r => setTimeout(r, 1500));
    response = await attemptJoin(retries + 2);
    retries++;
  }

  if (response && response.joinScript) {
    const udmuxAddress = response.joinScript.UdmuxEndpoints && response.joinScript.UdmuxEndpoints.length > 0
      ? response.joinScript.UdmuxEndpoints[0].Address
      : null;
    return {
      machineAddress: response.joinScript.MachineAddress,
      publicAddress: udmuxAddress,
      dataCenterId: response.joinScript.DataCenterId
    };
  }

  // No raw dump: a failure body can still carry machine / IP-derived names.
  // The whitelisted fields were already logged per attempt above.
  console.log(`[gamejoin] gave up after ${retries + 1} attempt(s) without a joinScript.`);
  return null;
}

/**
 * Logs a single join-game-instance attempt using ONLY whitelisted fields.
 * Never logs the raw response body, machineAddress, public addresses/IPs,
 * cookies, CSRF tokens, bearer/Authorization headers or secrets.
 * @param {{attempt:number, httpStatus:number|null, csrfPresent:boolean,
 *          replacementReceived:boolean, response:object}} log
 */
function logGameJoinAttempt({ attempt, httpStatus, csrfPresent, replacementReceived, response }) {
  const joinScript = !!(response && response.joinScript);
  const fields = [
    `attempt=${attempt}`,
    `httpStatus=${httpStatus}`,
    `joinScript=${joinScript ? 'true' : 'false'}`,
    `csrfPresent=${csrfPresent ? 'true' : 'false'}`,
    `replacementCookieReceived=${replacementReceived ? 'true' : 'false'}`
  ];

  if (response) {
    // Whitelisted response fields only (never the raw body).
    const rs = response.status;
    if (rs !== undefined && rs !== null && (typeof rs === 'number' || /^\d+$/.test(String(rs)))) {
      fields.push(`responseStatus=${rs}`);
    }
    if (typeof response.statusMessage === 'string' && response.statusMessage) {
      fields.push(`statusMessage=${JSON.stringify(response.statusMessage)}`);
    }
    if (response.queuePosition !== undefined && response.queuePosition !== null) {
      fields.push(`queuePosition=${response.queuePosition}`);
    }

    // Roblox error surfaces vary by shape:
    //   { errors: [{ code, subcode?, message }] },
    //   { error: { code, subcode?, message } },
    //   { errorCode / errorSubcode / errorMessage }.
    let ec, esc, em;
    if (Array.isArray(response.errors) && response.errors.length > 0 && response.errors[0]) {
      const first = response.errors[0];
      if (ec === undefined && first.code !== undefined) ec = first.code;
      if (esc === undefined && first.subcode !== undefined) esc = first.subcode;
      if (em === undefined && first.message !== undefined) em = first.message;
    }
    if (ec === undefined && response.errorCode !== undefined) ec = response.errorCode;
    if (esc === undefined && response.errorSubcode !== undefined) esc = response.errorSubcode;
    if (em === undefined && typeof response.errorMessage === 'string') em = response.errorMessage;
    if (response.error && typeof response.error === 'object') {
      if (ec === undefined && response.error.code !== undefined) ec = response.error.code;
      if (esc === undefined && response.error.subcode !== undefined) esc = response.error.subcode;
      if (em === undefined && response.error.message !== undefined) em = response.error.message;
    }
    if (ec !== undefined) fields.push(`errorCode=${ec}`);
    if (esc !== undefined) fields.push(`errorSubcode=${esc}`);
    if (em !== undefined) fields.push(`errorMessage=${JSON.stringify(em)}`);
  }

  console.log(`[gamejoin] ${fields.join(' ')}`);
}

// Live binding: callers reading `BOT_COOKIE` after an in-memory rotation still
// see the cookie actually in use (a plain property would snapshot the value).
const robloxAuthExports = { getCsrfToken, getServerIp, checkRobloxCookieAuth };
Object.defineProperty(robloxAuthExports, 'BOT_COOKIE', {
    enumerable: true,
    get() { return botCookie; }
});
module.exports = robloxAuthExports;