/**
 * regionMap.js — Roblox server region detection using ONLY live geo services,
 * tried in this exact order:
 *   1. resolveRoValraDatacenterRegion(dataCenterId) — RoValra's public Roblox
 *      datacenter list (exact country per datacenter, no IP guessing)
 *   2. geolocateIp(publicAddress || machineAddress) — ip-api.com fallback
 * If BOTH fail to resolve a region, the caller reports 'Unknown'.
 *
 * No manual IP / data-center tables are used — every region comes from a
 * live third-party geolocation lookup, so results always reflect the server's
 * actual geographic location.
 *
 * The region codes returned here match the bot's canonical region set used
 * throughout the codebase (see countryCatalog REGIONS / normalizeRegion):
 *   ASIA, EU, NA, SA, OCEANIA, AFRICA, MIDDLE_EAST
 */
const { fetchWithTimeout } = require('./fetchTimeout');
/**
 * Asynchronous fallback that queries ip-api.com for the geographic location
 * of a public IP. Returns a `{ label, countryCode, ... }` object on success,
 * or null if the lookup fails / returns a non-success status. `countryCode`
 * (ISO-3166 alpha-2, e.g. SG, DE) lets the bot fire dashboard-configured
 * country pings in addition to the normalized broad region.
 * @param {string} ip - the public-facing IP
 * @returns {Promise<{label: string, countryCode: string|null, country: string|null, regionName: string|null, city: string|null}|null>}
 */
async function geolocateIp(ip, context = {}) {
  const guildId = context.guildId || 'unknown';
  const guildName = context.guildName || 'unknown';
  const placeId = context.placeId ?? 'n/a';
  const jobId = context.jobId || context.serverId || 'n/a';
  const username = context.robloxUsername || 'unknown';

  if (!ip) {
    console.warn(`[KAKUZU:IP] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} addressMissing=true IP geolocation failed`);
    return null;
  }

  const normalizedIp = String(ip).trim();
  if (isInvalidOrPrivateIp(normalizedIp)) {
    console.warn(`[KAKUZU:IP] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} IP geolocation failed invalidPrivateIp=true address=${JSON.stringify(normalizedIp)}`);
    return null;
  }

  console.log(`[KAKUZU:IP] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} resolvingAddress=${JSON.stringify(normalizedIp)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_API_TIMEOUT_MS);
  try {
    const res = await fetch(`http://ip-api.com/json/${normalizedIp}?fields=status,country,countryCode,regionName,city`, {
      signal: controller.signal
    });
    console.log(`[KAKUZU:IP] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} httpStatus=${res.status} target=http://ip-api.com/json/${normalizedIp}?fields=status,country,countryCode,regionName,city`);
    const data = await res.json();
    if (data && data.status === 'success') {
      console.log(`[KAKUZU:IP] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} country=${JSON.stringify(data.country || 'unknown')} countryCode=${JSON.stringify(data.countryCode || 'unknown')} region=${JSON.stringify(data.regionName || 'unknown')} city=${JSON.stringify(data.city || 'unknown')}`);
      return {
        label: `${data.city}, ${data.regionName}, ${data.country}`,
        countryCode: data.countryCode || null,
        country: data.country || null,
        regionName: data.regionName || null,
        city: data.city || null
      };
    }
    console.warn(`[KAKUZU:IP] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} IP geolocation failed status=${JSON.stringify((data && data.status) || 'unknown')} country=${JSON.stringify((data && data.country) || 'unknown')}`);
    return null;
  } catch (err) {
    console.error(`[KAKUZU:IP] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} IP geolocation failed error=${(err && err.message) || String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Country → normalized region code -------------------------------------
// Derived from handlers/countryCatalog.js — the SINGLE source of truth shared
// with the /pingsetup builder — so the detector can never disagree with what
// the builder offers. Every ISO-3166 alpha-2 country (including territories)
// maps to one canonical region; legacy/non-ISO aliases (RoValra quirks like
// the 'SINGAPORE' typo, 'USA', 'UK', ...) are appended on top.
const countryCatalogDb = require('./countryCatalog');

function logRegionContext(prefix, context = {}, message, extra = {}) {
  const guildId = context.guildId || 'unknown';
  const guildName = context.guildName || 'unknown';
  const placeId = context.placeId ?? 'n/a';
  const jobId = context.jobId || context.serverId || 'n/a';
  const username = context.robloxUsername || 'unknown';
  const base = [prefix, `guild=${guildId}`, `guildName=${JSON.stringify(guildName)}`, `placeId=${placeId}`, `jobId=${JSON.stringify(jobId)}`, `robloxUser=${JSON.stringify(username)}`];
  const kv = Object.entries(extra).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  console.log(base.concat(kv).join(' ') + ' ' + message);
}

function getIpGeoLogContext(ip, context = {}) {
  return {
    protocol: 'https',
    ip: ip ? String(ip).trim() : 'n/a',
    guildId: context.guildId || 'unknown',
    guildName: context.guildName || 'unknown',
    placeId: context.placeId ?? 'n/a',
    jobId: context.jobId || context.serverId || 'n/a',
    robloxUsername: context.robloxUsername || 'unknown'
  };
}

function isInvalidOrPrivateIp(ip) {
  const value = String(ip || '').trim();
  if (!value) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  const parts = value.split('.').map(Number);
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 198 && b === 18) {
    return true;
  }
  return false;
}

const COUNTRY_TO_REGION = {};
for (const [name, region] of countryCatalogDb.COUNTRY_NAME_TO_REGION) {
  COUNTRY_TO_REGION[name] = region;
}
Object.assign(COUNTRY_TO_REGION, {
  // Legacy aliases that are NOT exact catalog English names.
  'SINGAPORE': 'ASIA',
  'KOREA': 'ASIA',
  'USA': 'NA',
  'US': 'NA',
  'UK': 'EU',
  'UAE': 'MIDDLE_EAST',
  'EMIRATES': 'MIDDLE_EAST',
  'CZECH REPUBLIC': 'EU',
  'RUSSIA': 'EU',
  'IVORY COAST': 'AFRICA',
  'DEMOCRATIC REPUBLIC OF THE CONGO': 'AFRICA',
  'THE NETHERLANDS': 'EU'
});

/**
 * Translates a country name (as returned by the RoValra service) into a
 * bot-normalized region code. Returns null when the country is unknown so the
 * caller can fall through instead of guessing.
 * @param {string} country - a country / region label
 * @returns {string|null} normalized region code, or null if unmapped
 */
function normalizeCountryToRegion(country) {
  if (!country) return null;
  const value = String(country).trim().toUpperCase();
  return COUNTRY_TO_REGION[value] || null;
}

// ---- ISO-3166 alpha-2 country CODE → normalized region --------------------
// RoValra's datacenter list returns short ISO codes ('IN', 'US', ...) while the
// name map above uses full country names — this covers both. Derived from the
// shared country catalog so the builder/detector can never disagree.
const COUNTRY_CODE_TO_REGION = {};
for (const [code, region] of countryCatalogDb.COUNTRY_CODE_TO_REGION) {
  COUNTRY_CODE_TO_REGION[code] = region;
}
// Legacy non-ISO aliases the detector may still produce (UK for GB, ...).
Object.assign(COUNTRY_CODE_TO_REGION, {
  UK: 'EU'
});

/**
 * Translates an ISO-3166 alpha-2 country code (e.g. 'IN') into a
 * bot-normalized region code. Returns null when the code is unknown.
 * @param {string} code - ISO-3166 alpha-2 country code
 * @returns {string|null} normalized region code, or null if unmapped
 */
function normalizeCountryCodeToRegion(code) {
  if (!code) return null;
  return COUNTRY_CODE_TO_REGION[String(code).trim().toUpperCase()] || null;
}

// ---- RoValra geolocation (Roblox datacenter list) --------------------------
// NOTE: apis.rovalra.com is a THIRD-PARTY / developer-controlled service, not
// an official Roblox API. RoValra (the open-source Roblox extension) exposes a
// PUBLIC datacenter list that maps every Roblox dataCenterId to its physical
// location ({ city, region, country (ISO-2), country_name, latLong }). The
// bot's gamejoin API already returns the server's dataCenterId, so RoValra
// resolves the server's country EXACTLY — no IP guessing involved.
// The old invented `GET /v1/geolocation?ip=` endpoint returned 404 for every
// IP and never worked.
const ROVALRA_DC_LIST_ENDPOINT = 'https://apis.rovalra.com/v1/datacenters/list';
const ROVALRA_TIMEOUT_MS = Number(process.env.ROVALRA_TIMEOUT_MS || 8000);
const ROVALRA_CACHE_TTL_MS = 60 * 60 * 1000; // datacenter list is stable — 1h cache
const ROVALRA_MAX_RETRIES = 2;
const ROVALRA_RETRY_BASE_MS = 1000;
const ROVALRA_DC_ID_CACHE_TTL_MS = 60 * 60 * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isTransientHttpStatus(status) {
    return status >= 500 || status === 429;
}
const GEO_API_TIMEOUT_MS = 4000;

// In-memory cache of dataCenterId -> location { city, region, country, country_name }.
let rovalraMapCachedAt = 0;
const rovalraDcIdCache = new Map(); // dataCenterId -> { location, at }
let rovalraInFlight = null;

async function fetchRoValraDatacenterMap(context = {}) {
  const guildId = context.guildId || 'unknown';
  const guildName = context.guildName || 'unknown';
  const placeId = context.placeId ?? 'n/a';
  const jobId = context.jobId || context.serverId || 'n/a';
  const username = context.robloxUsername || 'unknown';
  const base = `guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)}`;

  // 1) In-flight deduplication: only one map fetch in flight at a time.
  if (rovalraInFlight) {
    console.log(`[KAKUZU:ROVALRA:CACHE] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} in_flight_dedup=true`);
    return rovalraInFlight;
  }

  // 2) Whole-map cache freshness + per-dataCenterId bounded cache.
  if (rovalraMapCachedAt && Date.now() - rovalraMapCachedAt < ROVALRA_CACHE_TTL_MS) {
    const map = new Map();
    const now = Date.now();
    for (const [id, entry] of rovalraDcIdCache) {
      if (now - entry.at < ROVALRA_DC_ID_CACHE_TTL_MS) map.set(id, entry.location);
    }
    if (map.size > 0) {
      console.log(`[KAKUZU:ROVALRA:CACHE] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} cache_hit=true entries=${map.size}`);
      return map;
    }
  }

  // 3) Fetch with retries for transient failures only (5xx, 429, network, timeout).
  rovalraInFlight = (async () => {
    for (let attempt = 0; attempt <= ROVALRA_MAX_RETRIES; attempt++) {
      try {
        console.log(`[KAKUZU:ROVALRA:HTTP] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} attempt=${attempt + 1} timeout_ms=${ROVALRA_TIMEOUT_MS}`);
        const res = await fetchWithTimeout(ROVALRA_DC_LIST_ENDPOINT, {}, ROVALRA_TIMEOUT_MS);
        console.log(`[KAKUZU:ROVALRA:HTTP] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} attempt=${attempt + 1} http_status=${res.status}`);
        if (!res.ok) {
          if (isTransientHttpStatus(res.status) && attempt < ROVALRA_MAX_RETRIES) {
            const retryAfter = res.headers.get('retry-after');
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : ROVALRA_RETRY_BASE_MS * (attempt + 1);
            console.warn(`[KAKUZU:ROVALRA] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} attempt=${attempt + 1} http_status=${res.status} transient=true retry_in_ms=${delay}`);
            await sleep(delay);
            continue;
          }
          console.warn(`[KAKUZU:ROVALRA] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} attempt=${attempt + 1} http_status=${res.status} transient=false`);
          return null;
        }
        let list;
        try { list = await res.json(); } catch (err) {
          console.warn(`[KAKUZU:ROVALRA:HTTP] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} attempt=${attempt + 1} malformed_json=true error=${err.message}`);
          return null;
        }
        if (!Array.isArray(list)) {
          console.warn(`[KAKUZU:ROVALRA:HTTP] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} attempt=${attempt + 1} invalid_payload=true`);
          return null;
        }
        const map = new Map();
        const now = Date.now();
        for (const entry of list) {
          if (!entry || !Array.isArray(entry.dataCenterIds) || !entry.location) continue;
          for (const id of entry.dataCenterIds) {
            const nid = Number(id);
            map.set(nid, entry.location);
            rovalraDcIdCache.set(nid, { location: entry.location, at: now });
          }
        }
        rovalraMapCachedAt = now;
        console.log(`[KAKUZU:ROVALRA:CACHE] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} cache_updated=true entries=${list.length} map_size=${map.size}`);
        return map;
      } catch (err) {
        const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('timed out'));
        console.warn(`[KAKUZU:ROVALRA:HTTP] ${base} endpoint=${ROVALRA_DC_LIST_ENDPOINT} attempt=${attempt + 1} error=${(err && err.message) || String(err)} transient=${isTimeout}`);
        if (attempt < ROVALRA_MAX_RETRIES) {
          await sleep(ROVALRA_RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        return null;
      }
    }
    return null;
  })();

  rovalraInFlight.then(() => { rovalraInFlight = null; }).catch(() => { rovalraInFlight = null; });
  return rovalraInFlight;
}
/**
 * Resolves a Roblox game server's dataCenterId to a NORMALIZED region code +
 * ISO country code via the RoValra datacenter list. Returns null on any
 * failure (non-200, timeout, unknown datacenter) so the caller falls through
 * to ip-api.com. No raw IPs are ever sent to RoValra — only the datacenter ID.
 * @param {string|number} dataCenterId - DataCenterId from the gamejoin joinScript
 * @returns {Promise<{region: string|null, countryCode: string|null, countryName: string|null, city: string|null, label: string|null}|null>}
 */
async function resolveRoValraDatacenterRegion(dataCenterId, context = {}) {
  const guildId = context.guildId || 'unknown';
  const guildName = context.guildName || 'unknown';
  const placeId = context.placeId ?? 'n/a';
  const jobId = context.jobId || context.serverId || 'n/a';
  const username = context.robloxUsername || 'unknown';

  if (dataCenterId == null) {
    console.warn(`[KAKUZU:ROVALRA] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} missingDataCenterId=true`);
    return null;
  }

  const map = await fetchRoValraDatacenterMap(context);
  if (!map) {
    console.warn(`[KAKUZU:ROVALRA] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} noDatacenterMap=true`);
    return null;
  }

  const location = map.get(Number(dataCenterId));
  if (!location) {
    console.warn(`[KAKUZU:ROVALRA] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} dataCenterId=${JSON.stringify(String(dataCenterId))} lookupMiss=true`);
    return null;
  }

  const countryCode = location.country || null;
  const countryName = location.country_name || null;
  const city = location.city || null;
  const region = normalizeCountryToRegion(countryName)
    || normalizeCountryCodeToRegion(countryCode)
    || null;
  if (!region || !countryCode) {
    console.warn(`[KAKUZU:ROVALRA] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} country=${JSON.stringify(countryName || 'unknown')} countryCode=${JSON.stringify(countryCode || 'unknown')} region=${JSON.stringify(region || 'unknown')} mapStatus=unmapped`);
  }

  const labelParts = [city, countryName].filter(Boolean);
  console.log(`[KAKUZU:ROVALRA] guild=${guildId} guildName=${JSON.stringify(guildName)} placeId=${placeId} jobId=${JSON.stringify(jobId)} robloxUser=${JSON.stringify(username)} country=${JSON.stringify(countryName || 'unknown')} countryCode=${JSON.stringify(countryCode || 'unknown')} city=${JSON.stringify(city || 'unknown')} mappedRegion=${JSON.stringify(region || 'unknown')} label=${JSON.stringify(labelParts.join(', ') || 'unknown')}`);

  return {
    region,
    countryCode,
    countryName,
    city,
    label: labelParts.length ? labelParts.join(', ') : null
  };
}

module.exports = {
  geolocateIp,
  normalizeCountryToRegion,
  normalizeCountryCodeToRegion,
  resolveRoValraDatacenterRegion
};