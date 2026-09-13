const test = require('node:test');
const assert = require('assert');

const {
    COUNTRIES,
    COUNTRIES_SORTED,
    COUNTRIES_BY_CODE,
    REGIONS,
    COUNTRY_CODE_TO_REGION,
    COUNTRY_NAME_TO_REGION,
    flagEmoji,
    getCountry,
    getCountryName,
    getRegionForCountryCode,
    getRegionForCountryName
} = require('../handlers/countryCatalog');

const CANONICAL_REGIONS = new Set(REGIONS.map((r) => r.key));

test('catalog contains the complete ISO 3166-1 alpha-2 set (>= 249 codes)', () => {
  assert.ok(COUNTRIES.length >= 249, `expected >= 249 countries, got ${COUNTRIES.length}`);
  assert.strictEqual(COUNTRIES_BY_CODE.size, COUNTRIES.length);
});

test('every catalog entry has a unique code and a canonical region', () => {
  const codes = new Set();
  for (const [code, name, region] of COUNTRIES) {
    assert.match(code, /^[A-Z]{2}$/, 'code must be 2 uppercase letters');
    assert.ok(name.length > 0, 'name must not be empty');
    assert.ok(CANONICAL_REGIONS.has(region), `bad region ${region} for ${code}`);
    assert.ok(!codes.has(code), `duplicate code ${code}`);
    codes.add(code);
  }
});

test('builder source-of-truth regions are exactly the required seven', () => {
  assert.deepStrictEqual(
    REGIONS.map((r) => r.key).sort(),
    ['AFRICA', 'ASIA', 'EU', 'MIDDLE_EAST', 'NA', 'OCEANIA', 'SA'].sort()
  );
});

test('countries are sorted alphabetically by English name', () => {
  const names = COUNTRIES_SORTED.map((c) => c.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(names, sorted);
});

test('every supported country is reachable through the 25-per-page selector', () => {
  const PAGE_SIZE = 25;
  const pageCount = Math.ceil(COUNTRIES_SORTED.length / PAGE_SIZE);
  assert.strictEqual(pageCount, 10, '250 countries / 25 per page = 10 pages');

  const seen = new Set();
  for (let page = 1; page <= pageCount; page++) {
    const start = (page - 1) * PAGE_SIZE;
    const slice = COUNTRIES_SORTED.slice(start, start + PAGE_SIZE);
    assert.ok(slice.length <= PAGE_SIZE, 'a page must never exceed 25 options');
    for (const country of slice) seen.add(country.code);
  }
  // Every single code appears on exactly one page -> nobody is unreachable.
  assert.strictEqual(seen.size, COUNTRIES_SORTED.length);
  assert.ok(seen.has('IN') && seen.has('US') && seen.has('DE') && seen.has('SG'));
  assert.ok(seen.has('ZW'), 'last alphabetical country reachable');
});

test('catalog and region detector agree (regionMap uses the catalog)', () => {
  const regionMap = require('../handlers/regionMap');
  // Australia is now part of OCEANIA (canonical set, single source of truth).
  assert.strictEqual(getRegionForCountryCode('AU'), 'OCEANIA');
  assert.strictEqual(getRegionForCountryCode('NZ'), 'OCEANIA');
  // Germany -> EU, India/Singapore -> ASIA, United States -> NA.
  assert.strictEqual(getRegionForCountryCode('DE'), 'EU');
  assert.strictEqual(getRegionForCountryCode('IN'), 'ASIA');
  assert.strictEqual(getRegionForCountryCode('SG'), 'ASIA');
  assert.strictEqual(getRegionForCountryCode('US'), 'NA');

  // The detector resolves the SAME codes through the catalog.
  assert.strictEqual(regionMap.normalizeCountryCodeToRegion('DE'), 'EU');
  assert.strictEqual(regionMap.normalizeCountryCodeToRegion('in'), 'ASIA');
  assert.strictEqual(regionMap.normalizeCountryCodeToRegion('UK'), 'EU'); // legacy alias kept
  // Detector's name path also agrees with the catalog (RoValra names).
  assert.strictEqual(regionMap.normalizeCountryToRegion('Germany'), 'EU');
  assert.strictEqual(regionMap.normalizeCountryToRegion('India'), 'ASIA');
  // Legacy RoValra quirk alias is preserved.
  assert.strictEqual(regionMap.normalizeCountryToRegion('SINGAPORE'), 'ASIA');
});

test('countryCodeToName uses the catalog (embeds and builder agree)', () => {
  const rsm = require('../handlers/raidStateManager');
  assert.strictEqual(rsm.countryCodeToName('IN'), 'India');
  assert.strictEqual(rsm.countryCodeToName('SG'), 'Singapore');
  assert.strictEqual(rsm.countryCodeToName('DE'), 'Germany');
  assert.strictEqual(rsm.countryCodeToName('US'), 'United States');
  assert.strictEqual(rsm.countryCodeToName('in'), 'India');
  assert.strictEqual(rsm.countryCodeToName('  de  '), 'Germany');
  assert.strictEqual(rsm.countryCodeToName(null), 'Unknown');
  assert.strictEqual(rsm.countryCodeToName(''), 'Unknown');
});

test('lookup helpers are case-insensitive and derived from the same catalog', () => {
  assert.strictEqual(getCountry('IN').name, 'India');
  assert.strictEqual(getCountry('in').name, 'India');
  assert.strictEqual(getCountry(null), null);
  assert.strictEqual(getCountryName('us'), 'United States');
  assert.strictEqual(getCountryName('ZZ'), null);
  assert.strictEqual(getRegionForCountryName('Germany'), 'EU');
  assert.strictEqual(getRegionForCountryName('germany'), 'EU');
  assert.strictEqual(getRegionForCountryName('Atlantis'), null);
});

test('flag emoji derives from the ISO code (regional indicators)', () => {
  const flag = flagEmoji('IN');
  assert.strictEqual(flag.codePointAt(0), 0x1f1ee); // 🇮 (regional indicator I)
  assert.strictEqual(flag.codePointAt(2), 0x1f1f3); // 🇳 (regional indicator N)
  assert.strictEqual(flagEmoji(''), '🏳️');
  assert.strictEqual(flagEmoji('XYZ'), '🏳️');
});