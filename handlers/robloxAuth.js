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

const { fetchWithTimeout } = require('./fetchTimeout');
// Hard deadline for gamejoin / auth-cookie probes: an unbounded fetch here is
// the slowest call on the request_backup path (cookie probe + gamejoin +
// presence + RoValra + ip-api) and would blow the 3s Discord ack window.
const GAMEJOIN_FETCH_TIMEOUT_MS = 10000;
const GAMEJOIN_URL = 'https://gamejoin.roblox.com/v1/join-game-instance';

let botCookie = process.env.BOT_ROBLOSECURITY || '';
// Env value that was active when we last adopted a rotated cookie. Used by
// refreshCookieFromEnv() so a stale env var does not clobber a fresher rotated
// token on the next call (see requirement: "retain the new token for future
// requests"). It only re-applies env when the OPERATOR changes the env value.
let rotatedFromEnvCookie = null;

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
        // Remember which env value we are rotating away from so a later
        // refreshCookieFromEnv() does not resurrect the stale cookie.
        rotatedFromEnvCookie = process.env.BOT_ROBLOSECURITY || null;
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
        const res = await fetchWithTimeout('https://users.roblox.com/v1/users/authenticated', {
            headers: {
                'Cookie': `.ROBLOSECURITY=${botCookie}`,
                'User-Agent': 'Roblox/WinInet'
            }
        }, GAMEJOIN_FETCH_TIMEOUT_MS);
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

// Last gamejoin attempt diagnostics (safe: whitelisted fields only, never the
// raw body, IPs, cookies or tokens). Powers /raiddebug so admins can inspect
// the latest attempt on Render without grepping thousands of log lines.
let lastGameJoinAttempt = null;
function getLastGameJoinAttempt() {
  return lastGameJoinAttempt ? Object.assign({}, lastGameJoinAttempt) : null;
}

function refreshCookieFromEnv() {
  const fromEnv = process.env.BOT_ROBLOSECURITY || '';
  if (!fromEnv || fromEnv === botCookie) return;
  // If we already rotated away from THIS exact env value, keep the rotation:
  // the env var is now stale and clobbering it back would undo the Set-Cookie
  // refresh. Re-apply env only when the operator supplied a NEW value.
  if (rotatedFromEnvCookie !== null && fromEnv === rotatedFromEnvCookie) return;
  botCookie = fromEnv;
  rotatedFromEnvCookie = null; // operator supplied a fresh env cookie
}

function isCookieConfigured() {
  refreshCookieFromEnv();
  return Boolean(botCookie && botCookie.length > 0);
}

/**
 * Maps a failed gamejoin response to a stable blocker code so /raiddebug and
 * the staged logs can name the exact failure without guessing (challenge vs
 * origin vs auth vs rate-limit vs network).
 */
function classifyGameJoinBlocker(httpStatus, response) {
  const msg = String((response && (response.errorMessage
    || (response.error && response.error.message)
    || (Array.isArray(response.errors) && response.errors[0] && response.errors[0].message))) || '');
  const hasChallengeHeader = Boolean(response && response.challengeType);
  // Challenge is identified by EITHER the body message OR the presence of an
  // rblx-challenge-type header (which names the specific challenge method).
  if (/challenge is required/i.test(msg) || (hasChallengeHeader && httpStatus === 403)) return 'roblox_challenge_required';
  if (httpStatus === 403) return 'forbidden_origin_or_token';
  if (httpStatus === 401) return 'unauthorized_cookie';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus != null && httpStatus >= 500) return 'roblox_server_error';
  if (/unparseable/i.test(msg)) return 'unparseable_response';
  if (httpStatus === 400) return 'bad_request_ids';
  return 'no_join_script';
}

/**
 * Pulls the whitelisted location fields out of a gamejoin joinScript.
 * `publicAddress` is the public-facing IP from UdmuxEndpoints[0].Address.
 */
function extractJoinLocation(response) {
  const udmuxAddress = Array.isArray(response.joinScript.UdmuxEndpoints)
    && response.joinScript.UdmuxEndpoints[0]
    && typeof response.joinScript.UdmuxEndpoints[0].Address === 'string'
    ? response.joinScript.UdmuxEndpoints[0].Address
    : null;
  return {
    machineAddress: response.joinScript.MachineAddress,
    publicAddress: udmuxAddress,
    dataCenterId: response.joinScript.DataCenterId
  };
}

async function getCsrfToken() {
  // Probe WITH the cookie: Roblox only returns an x-csrf-token for an
  // authenticated session. The old probed WITHOUT any cookie, so it never
  // received a token and every gamejoin POST went out unauthenticated.
  if (!botCookie) return null;
  const res = await fetchWithTimeout('https://auth.roblox.com/v2/logout', {
    method: 'POST',
    headers: { Cookie: `.ROBLOSECURITY=${botCookie}` }
  }, GAMEJOIN_FETCH_TIMEOUT_MS);
  return res.headers.get('x-csrf-token');
}

// ---------------------------------------------------------------------------
// Pure predicate: is this response a Roblox "challenge required" 403?
// A challenge is identified by EITHER the body message ("Challenge is required
// to authorize the request") OR the presence of an rblx-challenge-type header.
// Retrying a challenge is explicitly prohibited (it cannot succeed), so this
// gates the CSRF handshake in fetchRobloxGameInstance() and the branch in
// getServerIp().
// ---------------------------------------------------------------------------
function isChallengeShaped403(httpStatus, body, challengeType) {
  const msg = String((body && (body.errorMessage
    || (body.error && body.error.message)
    || (Array.isArray(body.errors) && body.errors[0] && body.errors[0].message))) || '');
  const fields = [
    String(body && body.status !== undefined ? body.status : ''),
    String((body && body.statusMessage) || ''),
    String((body && body.errorCode) || ''),
    msg,
    String((body && body.errorSubcode) || '')
  ].join(' ').toLowerCase();
  const hasChallengeHeader = Boolean(challengeType);
  return (httpStatus === 403 || (body && body.status === 403))
    && (/challenge/i.test(fields) || hasChallengeHeader);
}

/**
 * Reads one gamejoin Response into the enriched, whitelisted shape the rest of
 * this module (and /raiddebug) consumes. The parsed body is augmented with
 * httpStatus + challenge header facts so downstream code can branch on HEADERS,
 * not just body text (the live challenge body has no `status: 403` field).
 */
async function readGameJoinResponse(res) {
  // Inspect Roblox challenge headers (safe: only the public challenge-type enum
  // value and presence booleans are surfaced — never the challenge-id value
  // itself, never metadata contents, never cookies/CSRF tokens/IPs).
  const challengeType = res.headers.get('rblx-challenge-type') || null;
  const challengeIdPresent = Boolean(res.headers.get('rblx-challenge-id'));
  const challengeMetaPresent = Boolean(res.headers.get('rblx-challenge-metadata'));
  const responseContentType = res.headers.get('content-type') || null;
  let body;
  let bodyJsonValid = false;
  try { body = await res.json(); bodyJsonValid = true; } catch (_) { body = {}; }
  if (body && typeof body === 'object') {
    body.httpStatus = res.status;
    body.challengeType = challengeType;
    body.challengeIdPresent = challengeIdPresent;
    body.challengeMetaPresent = challengeMetaPresent;
    body.responseContentType = responseContentType;
    body.bodyJsonValid = bodyJsonValid;
  }
  return {
    body,
    challengeType,
    challengeIdPresent,
    challengeMetaPresent,
    responseContentType,
    bodyJsonValid,
    isChallengeRequired: isChallengeShaped403(res.status, body, challengeType)
  };
}

// ---------------------------------------------------------------------------
// fetchRobloxGameInstance — the single, dedicated gamejoin POST helper.
//
// Responsibilities (HTTP-level only; no raid logic):
//   1. CSRF handshake: POST with Cookie / Content-Type / User-Agent (+ the
//      Referer Roblox's anti-automation check requires). On a PLAIN (non-
//      challenge) 403, read x-csrf-token from the response headers and
//      instantly retry the EXACT same request once with that token appended.
//      A Roblox CHALLENGE 403 is NEVER retried (prohibited + cannot succeed).
//   2. Dynamic cookie refresh: any Set-Cookie replacement .ROBLOSECURITY is
//      adopted IN MEMORY (never logged, never persisted) so later requests use
//      the fresh token instead of a stale one. The optional onCookieRotated
//      callback receives the new value for callers that wish to persist it.
//   3. Explicit auth failure: a 401 throws a named, secret-free error so the
//      operator immediately knows the cookie was revoked / expired.
//   4. Returns the parsed gamejoin payload (joinScript with MachineAddress /
//      UdmuxEndpoints / DataCenterId on success).
//
// Every request is deadline-bounded by fetchWithTimeout (GAMEJOIN_FETCH_TIMEOUT_MS).
// ---------------------------------------------------------------------------
async function fetchRobloxGameInstance(placeId, serverId, options = {}) {
  const attempt = Number(options.attempt) > 0 ? Number(options.attempt) : 1;
  const preFetchedCsrf = (typeof options.csrfToken === 'string' && options.csrfToken) ? options.csrfToken : null;
  const onCookieRotated = typeof options.onCookieRotated === 'function' ? options.onCookieRotated : null;
  const diag = options.diag || {};
  const diagGuildId = diag.guildId || 'unknown';
  const diagRaidId = (diag.raidId != null) ? String(diag.raidId) : 'n/a';

  const noteAttempt = (info) => {
    lastGameJoinAttempt = Object.assign({ at: Date.now(), guildId: diagGuildId, raidId: diagRaidId }, info);
  };

  // The EXACT same body is used for the initial request and any CSRF retry.
  const bodyJson = JSON.stringify({
    placeId: placeId,
    isTeleport: false,
    gameId: serverId,
    gameJoinAttemptId: serverId
  });

  const buildHeaders = (csrfToken) => {
    const headers = {
      'Content-Type': 'application/json',
      'Cookie': `.ROBLOSECURITY=${botCookie}`,
      'User-Agent': 'Roblox/WinInet',
      'Referer': 'https://www.roblox.com/games/' + placeId
    };
    if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken; // token value is NEVER logged
    return headers;
  };

  const post = (csrfToken) => fetchWithTimeout(GAMEJOIN_URL, {
    method: 'POST',
    headers: buildHeaders(csrfToken),
    body: bodyJson
  }, GAMEJOIN_FETCH_TIMEOUT_MS);

  // Attempt the join. A pre-fetched CSRF token is sent up front (skips the
  // handshake round-trip); otherwise the first POST goes out without a token
  // and the 403 handshake below supplies it.
  let usedCsrf = preFetchedCsrf;
  let res = await post(usedCsrf || undefined);
  let parsed = await readGameJoinResponse(res);
  let csrfRetried = false;

  // CSRF handshake: a PLAIN (non-challenge) 403 carrying x-csrf-token means the
  // token expired / rotated. Retry the exact same POST once with the new token.
  if (res.status === 403 && !parsed.isChallengeRequired) {
    const handshakeToken = res.headers.get('x-csrf-token');
    if (handshakeToken) {
      csrfRetried = true;
      usedCsrf = handshakeToken;
      res = await post(handshakeToken);
      parsed = await readGameJoinResponse(res);
    }
  }

  // Respect cookie rotation: capture any replacement .ROBLOSECURITY offered via
  // Set-Cookie on the FINAL response. It is adopted ONLY when this join actually
  // authenticated (a joinScript came back) — a failed auth can return a fresh
  // ANONYMOUS guest cookie which would break all subsequent calls. The value is
  // NEVER logged.
  const replacement = extractReplacementSecurityCookie(res);
  const authenticated = Boolean(parsed.body && parsed.body.joinScript);
  if (authenticated) {
    adoptReplacementCookieIfAuthenticated(replacement, true);
    if (onCookieRotated && replacement.received && replacement.value) {
      try { onCookieRotated(decodeURIComponent(replacement.value)); }
      catch (_) { onCookieRotated(replacement.value); } // value is NEVER logged
    }
  }

  // Expose the handshake facts on the body so downstream challenge detection +
  // diagnostics can read them off the response object.
  parsed.body.csrfPresent = Boolean(usedCsrf);
  parsed.body.csrfRetried = csrfRetried;
  parsed.body.replacementCookieReceived = replacement.received;

  // Safe whitelisted per-attempt diagnostic (no raw body / secrets / IPs).
  logGameJoinAttempt({
    attempt,
    httpStatus: res.status,
    csrfPresent: Boolean(usedCsrf),
    csrfRetried,
    replacementReceived: replacement.received,
    response: parsed.body,
    challengeType: parsed.challengeType,
    challengeIdPresent: parsed.challengeIdPresent,
    challengeMetaPresent: parsed.challengeMetaPresent,
    responseContentType: parsed.responseContentType,
    bodyJsonValid: parsed.bodyJsonValid
  });

  // Persist the SAME whitelisted fields for getLastGameJoinAttempt() so
  // /raiddebug can name the exact failing stage without grepping Render logs.
  // Never the cookie, CSRF token, raw body, IPs or headers.
  {
    const joinScriptFound = authenticated;
    noteAttempt({
      attempt,
      placeId: String(placeId),
      serverId: String(serverId),
      httpStatus: res.status,
      joinScript: joinScriptFound,
      csrfPresent: Boolean(usedCsrf),
      csrfRetried,
      replacementCookieReceived: replacement.received,
      challengeType: parsed.challengeType || null,
      challengeHeadersPresent: Boolean(parsed.challengeType),
      challengeIdPresent: parsed.challengeIdPresent,
      challengeMetaPresent: parsed.challengeMetaPresent,
      responseContentType: parsed.responseContentType || null,
      bodyJsonValid: parsed.bodyJsonValid,
      responseStatus: parsed.body && parsed.body.status !== undefined ? parsed.body.status : null,
      queuePosition: parsed.body && parsed.body.queuePosition !== undefined ? parsed.body.queuePosition : null,
      errorCode: parsed.body && parsed.body.errorCode !== undefined ? parsed.body.errorCode : null,
      errorMessage: parsed.body && typeof parsed.body.errorMessage === 'string' ? parsed.body.errorMessage : null,
      blocker: joinScriptFound ? null : classifyGameJoinBlocker(res.status, parsed.body)
    });
  }

  // Explicit, secret-free auth failure so a revoked/expired cookie is NAMED
  // instead of surfacing as a generic "no joinScript" blocker.
  if (res.status === 401) {
    console.error(`[gamejoin] [Roblox Auth Error] The .ROBLOSECURITY cookie has been revoked or expired. (guild=${diagGuildId} raidId=${diagRaidId} attempt=${attempt})`);
    throw new Error('[Roblox Auth Error] The .ROBLOSECURITY cookie has been revoked or expired.');
  }

  return parsed.body;
}

async function getServerIp(placeId, serverId, context = {}) {
  refreshCookieFromEnv();
  const diagGuildId = (context && context.guildId) || 'unknown';
  const diagRaidId = (context && context.raidId != null) ? String(context.raidId) : 'n/a';
  // Safe authenticated-cookie diagnostic BEFORE any gamejoin attempt.
  await checkRobloxCookieAuth('pre-gamejoin');

  const diag = { guildId: diagGuildId, raidId: diagRaidId };

  // The ONLY request we make (plus the queue-position retry loop below). We
  // must NOT retry a Roblox challenge: Roblox returns HTTP 403 with "Challenge
  // is required to authorize the request" for unauthenticated/automation-
  // pattern requests, and retrying the same challenge (or rotating cookies /
  // fabricating auth data) is explicitly prohibited and cannot produce location
  // data. The join script + the machine/data-center fields we need never reach
  // the response, so location data is unavailable and we return a clear sentinel
  // rather than guessing. The CSRF handshake lives INSIDE
  // fetchRobloxGameInstance and is gated to plain 403s only.
  let response;
  try {
    response = await fetchRobloxGameInstance(placeId, serverId, {
      attempt: 1,
      csrfToken: await getCsrfToken(),
      diag
    });
  } catch (err) {
    // fetchRobloxGameInstance throws only on 401 (revoked/expired cookie) with
    // an explicit, secret-free message. Log it and keep the null contract so
    // callers (detectGameAndRegion) degrade to Unknown instead of throwing.
    console.warn(`[gamejoin] ${err && err.message ? err.message : 'request failed'} (guild=${diagGuildId} raidId=${diagRaidId})`);
    return null;
  }

  // Explicitly detect the Roblox challenge-required (403) response and handle
  // it without retrying. We can only distinguish it by whitelisted fields:
  // response.status (0 for network/parse failures, 22 for queue) and the
  // whitelisted error fields (errorCode / errorMessage). Any 403 that is not a
  // simple queue-position retry is a hard authorization challenge.
  const fields = [
    String(response.status),
    String(response.statusMessage || ''),
    String(response.errorCode || ''),
    String(response.errorMessage || ''),
    String(response.errorSubcode || '')
  ].join(' ').toLowerCase();
  // Use the HTTP status surfaced by the helper: the live challenge body does
  // NOT include a `status: 403` field (only errorCode/errorMessage), so
  // checking the body alone made this branch dead code. The challenge can
  // also be positively identified by the rblx-challenge-type response header.
  const hasChallengeHeader = Boolean(response.challengeType);
  const isChallengeRequired = (response.httpStatus === 403 || response.status === 403) && (/challenge/i.test(fields) || hasChallengeHeader);

  if (isChallengeRequired) {
    console.warn(
      `[gamejoin] challenge_required=true attempt=1 httpStatus=${response.httpStatus ?? 403} ` +
      `statusMessage="${String(response.statusMessage || 'Challenge is required to authorize the request')}" ` +
      `errorCode=${response.errorCode ?? 'none'} errorMessage="${String(response.errorMessage || 'none')}" ` +
      `challengeType=${response.challengeType || 'none'} challengeHeadersPresent=${hasChallengeHeader ? 'true' : 'false'} ` +
      `csrfPresent=${Boolean(response.csrfPresent)} csrfRetried=${Boolean(response.csrfRetried)} replacementCookieReceived=${Boolean(response.replacementCookieReceived)}`
    );
    return null;
  }

  let retries = 0;
  while (!response.joinScript && response.status === 22 && retries < 8) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      response = await fetchRobloxGameInstance(placeId, serverId, {
        attempt: retries + 2,
        csrfToken: await getCsrfToken(),
        diag
      });
    } catch (err) {
      console.warn(`[gamejoin] ${err && err.message ? err.message : 'request failed'} (queue retry guild=${diagGuildId} raidId=${diagRaidId})`);
      return null;
    }
    retries++;
  }

  if (response && response.joinScript) {
    return extractJoinLocation(response);
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
 * Challenge headers are logged as: challengeType (public enum value like
 * 'captcha'/'turnstile') + presence booleans only (never the challenge-id
 * value or metadata contents).
 * @param {{attempt:number, httpStatus:number|null, csrfPresent:boolean,
 *          replacementReceived:boolean, response:object,
 *          challengeType:string|null, challengeIdPresent:boolean,
 *          challengeMetaPresent:boolean, responseContentType:string|null,
 *          bodyJsonValid:boolean}} log
 */
function logGameJoinAttempt({ attempt, httpStatus, csrfPresent, csrfRetried, replacementReceived, response, challengeType, challengeIdPresent, challengeMetaPresent, responseContentType, bodyJsonValid }) {
  const joinScript = !!(response && response.joinScript);
  const fields = [
    `attempt=${attempt}`,
    `httpStatus=${httpStatus}`,
    `joinScript=${joinScript ? 'true' : 'false'}`,
    `csrfPresent=${csrfPresent ? 'true' : 'false'}`,
    `csrfRetried=${csrfRetried ? 'true' : 'false'}`,
    `replacementCookieReceived=${replacementReceived ? 'true' : 'false'}`,
    `challengeType=${challengeType || 'none'}`,
    `challengeHeadersPresent=${challengeType ? 'true' : 'false'}`,
    `responseContentType=${responseContentType || 'none'}`,
    `bodyJsonValid=${bodyJsonValid ? 'true' : 'false'}`
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
const robloxAuthExports = { getCsrfToken, getServerIp, fetchRobloxGameInstance, checkRobloxCookieAuth, getLastGameJoinAttempt, classifyGameJoinBlocker, isCookieConfigured };
Object.defineProperty(robloxAuthExports, 'BOT_COOKIE', {
    enumerable: true,
    get() { return botCookie; }
});
module.exports = robloxAuthExports;