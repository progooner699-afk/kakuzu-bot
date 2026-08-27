/**
 * regionMap.js — Roblox server region detection using ONLY live geo services:
 *   • resolveRoValraRegion(machineAddress) — RoValra (3rd party)
 *   • geolocateIp(publicAddress)          — ip-api.com
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
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city`);
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

// ---- RoValra geolocation (server region from machineAddress) ----------------
// NOTE: apis.rovalra.com is a THIRD-PARTY / developer-controlled service, not
// an official Roblox API. The gamejoin.roblox.com endpoint it depends on is an
// existing authenticated Roblox endpoint; using it with a .ROBLOSECURITY cookie
// may have policy / Terms-of-Service considerations. This function only makes a
// single, short, passive geolocation lookup keyed off the game server's
// machineAddress. It never stores, logs, or displays the raw IP.
const ROVALRA_ENDPOINT = 'https://apis.rovalra.com/v1/geolocation';
const ROVALRA_TIMEOUT_MS = 3000;

/**
 * Resolves a Roblox game server machineAddress to a NORMALIZED region code via
 * the third-party RoValra service. Returns null on any failure (non-200,
 * timeout, malformed JSON, unmapped country) so callers fall through.
 * Only the machineAddress is sent; raw IPs are never logged or stored.
 * @param {string} machineAddress - Roblox game server connection IP
 * @returns {Promise<{region: string|null, countryCode: string|null}|null>}
 *   resolved region object, or null
 */
async function resolveRoValraRegion(machineAddress) {
  if (!machineAddress) return null;
  const host = String(machineAddress).trim();
  if (!host) return null;

  // One-shot request with a hard timeout — never retried.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROVALRA_TIMEOUT_MS);
  try {
    const res = await fetch(`${ROVALRA_ENDPOINT}?ip=${encodeURIComponent(host)}`, {
      signal: controller.signal
    });
    if (!res.ok) return null;
    let data;
    try {
      data = await res.json();
    } catch {
      return null; // malformed JSON
    }
    // RoValra may return the country at the top level or nested (name + ISO code).
    const country = data?.country || data?.data?.country || null;
    const countryCode = data?.countryCode || data?.data?.countryCode
      || data?.country_code || data?.data?.country_code || null;
    const region = normalizeCountryToRegion(country);
    if (!region) return null;
    return { region, countryCode: countryCode || null };
  } catch {
    return null; // network error / timeout — never crash the raid request
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { geolocateIp, resolveRoValraRegion };