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
 * The region codes returned here match the bot's normalized region set used
 * throughout the codebase (see normalizeRegionInput / normalizeRegion):
 *   NA, SA, EU, ASIA, AUST, OCEANIA, MIDDLE_EAST, AFRICA
 */
/**
 * Asynchronous fallback that queries ip-api.com for the geographic location
 * of a public IP. Returns a `{ label, countryCode, ... }` object on success,
 * or null if the lookup fails / returns a non-success status. `countryCode`
 * (ISO-3166 alpha-2, e.g. SG, DE) lets the bot fire dashboard-configured
 * country pings in addition to the normalized broad region.
 * @param {string} ip - the public-facing IP
 * @returns {Promise<{label: string, countryCode: string|null, country: string|null, regionName: string|null, city: string|null}|null>}
 */
async function geolocateIp(ip) {
  if (!ip) return null;
  // Hard timeout so a hanging lookup can never stall the raid request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_API_TIMEOUT_MS);
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city`, {
      signal: controller.signal
    });
    const data = await res.json();
    if (data.status === 'success') {
      return {
        label: `${data.city}, ${data.regionName}, ${data.country}`,
        countryCode: data.countryCode || null,
        country: data.country || null,
        regionName: data.regionName || null,
        city: data.city || null
      };
    }
    return null;
  } catch (err) {
    console.error('geolocateIp failed:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Country → normalized region code -------------------------------------
// Translates a country name returned by RoValra into the bot's normalized
// region set (NA, SA, EU, ASIA, AUST, OCEANIA, MIDDLE_EAST, AFRICA).
// Only well-established mappings are included; an unknown country resolves to
// null so the caller falls through to the next source instead of guessing.
const COUNTRY_TO_REGION = {
  // Asia
  'SINGAPORE': 'ASIA',
  'JAPAN': 'ASIA',
  'INDIA': 'ASIA',
  'CHINA': 'ASIA',
  'SOUTH KOREA': 'ASIA',
  'KOREA': 'ASIA',
  'TAIWAN': 'ASIA',
  'HONG KONG': 'ASIA',
  'THAILAND': 'ASIA',
  'MALAYSIA': 'ASIA',
  'INDONESIA': 'ASIA',
  'PHILIPPINES': 'ASIA',
  'VIETNAM': 'ASIA',
  'PAKISTAN': 'ASIA',
  'BANGLADESH': 'ASIA',
  'SRI LANKA': 'ASIA',
  // North America
  'UNITED STATES': 'NA',
  'USA': 'NA',
  'US': 'NA',
  'CANADA': 'NA',
  'MEXICO': 'NA',
  // Europe
  'UNITED KINGDOM': 'EU',
  'UK': 'EU',
  'GERMANY': 'EU',
  'FRANCE': 'EU',
  'NETHERLANDS': 'EU',
  'ITALY': 'EU',
  'SPAIN': 'EU',
  'POLAND': 'EU',
  'SWEDEN': 'EU',
  'FINLAND': 'EU',
  'DENMARK': 'EU',
  'NORWAY': 'EU',
  'IRELAND': 'EU',
  'BELGIUM': 'EU',
  'PORTUGAL': 'EU',
  'SWITZERLAND': 'EU',
  'AUSTRIA': 'EU',
  'CZECHIA': 'EU',
  'ROMANIA': 'EU',
  'GREECE': 'EU',
  // South America
  'BRAZIL': 'SA',
  'ARGENTINA': 'SA',
  'CHILE': 'SA',
  'PERU': 'SA',
  'COLOMBIA': 'SA',
  'VENEZUELA': 'SA',
  // Australia / Oceania
  'AUSTRALIA': 'AUST',
  'NEW ZEALAND': 'OCEANIA',
  // Middle East
  'SAUDI ARABIA': 'MIDDLE_EAST',
  'EMIRATES': 'MIDDLE_EAST',
  'UAE': 'MIDDLE_EAST',
  'QATAR': 'MIDDLE_EAST',
  'KUWAIT': 'MIDDLE_EAST',
  'ISRAEL': 'MIDDLE_EAST',
  'TURKEY': 'MIDDLE_EAST',
  // Africa
  'SOUTH AFRICA': 'AFRICA',
  'NIGERIA': 'AFRICA',
  'KENYA': 'AFRICA',
  'EGYPT': 'AFRICA',
  'MOROCCO': 'AFRICA'
};

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
// name map above uses full country names — this covers both.
const COUNTRY_CODE_TO_REGION = {
  // Asia
  SG: 'ASIA', JP: 'ASIA', IN: 'ASIA', CN: 'ASIA', KR: 'ASIA', TW: 'ASIA',
  HK: 'ASIA', TH: 'ASIA', MY: 'ASIA', ID: 'ASIA', PH: 'ASIA', VN: 'ASIA',
  PK: 'ASIA', BD: 'ASIA', LK: 'ASIA',
  // North America
  US: 'NA', CA: 'NA', MX: 'NA',
  // Europe
  GB: 'EU', UK: 'EU', DE: 'EU', FR: 'EU', NL: 'EU', IT: 'EU', ES: 'EU',
  PL: 'EU', SE: 'EU', FI: 'EU', DK: 'EU', NO: 'EU', IE: 'EU', BE: 'EU',
  PT: 'EU', CH: 'EU', AT: 'EU', CZ: 'EU', RO: 'EU', GR: 'EU',
  // South America
  BR: 'SA', AR: 'SA', CL: 'SA', PE: 'SA', CO: 'SA', VE: 'SA',
  // Australia / Oceania
  AU: 'AUST', NZ: 'OCEANIA',
  // Middle East
  SA: 'MIDDLE_EAST', AE: 'MIDDLE_EAST', QA: 'MIDDLE_EAST', KW: 'MIDDLE_EAST',
  IL: 'MIDDLE_EAST', TR: 'MIDDLE_EAST',
  // Africa
  ZA: 'AFRICA', NG: 'AFRICA', KE: 'AFRICA', EG: 'AFRICA', MA: 'AFRICA'
};

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
const ROVALRA_TIMEOUT_MS = 8000;
const ROVALRA_CACHE_TTL_MS = 60 * 60 * 1000; // datacenter list is stable — 1h cache
const GEO_API_TIMEOUT_MS = 4000;

// In-memory cache of dataCenterId -> location { city, region, country, country_name }.
let rovalraDcCache = { map: null, at: 0 };

async function fetchRoValraDatacenterMap() {
  if (rovalraDcCache.map && Date.now() - rovalraDcCache.at < ROVALRA_CACHE_TTL_MS) {
    return rovalraDcCache.map;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROVALRA_TIMEOUT_MS);
  try {
    const res = await fetch(ROVALRA_DC_LIST_ENDPOINT, { signal: controller.signal });
    if (!res.ok) return null;
    let list;
    try {
      list = await res.json();
    } catch {
      return null; // malformed JSON
    }
    if (!Array.isArray(list)) return null;
    const map = new Map();
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.dataCenterIds) || !entry.location) continue;
      for (const id of entry.dataCenterIds) {
        map.set(Number(id), entry.location);
      }
    }
    rovalraDcCache = { map, at: Date.now() };
    return map;
  } catch {
    return null; // network error / timeout — never crash the raid request
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves a Roblox game server's dataCenterId to a NORMALIZED region code +
 * ISO country code via the RoValra datacenter list. Returns null on any
 * failure (non-200, timeout, unknown datacenter) so the caller falls through
 * to ip-api.com. No raw IPs are ever sent to RoValra — only the datacenter ID.
 * @param {string|number} dataCenterId - DataCenterId from the gamejoin joinScript
 * @returns {Promise<{region: string|null, countryCode: string|null, countryName: string|null, city: string|null, label: string|null}|null>}
 */
async function resolveRoValraDatacenterRegion(dataCenterId) {
  if (dataCenterId == null) return null;
  const map = await fetchRoValraDatacenterMap();
  if (!map) return null;
  const location = map.get(Number(dataCenterId));
  if (!location) return null;

  const countryCode = location.country || null;
  const countryName = location.country_name || null;
  const city = location.city || null;
  const region = normalizeCountryToRegion(countryName)
    || normalizeCountryCodeToRegion(countryCode)
    || null;
  // Human-readable label for embeds: "Mumbai, India" style.
  const labelParts = [city, countryName].filter(Boolean);
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