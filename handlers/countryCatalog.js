'use strict';

/**
 * countryCatalog.js — the bot's SINGLE source of truth for the ISO 3166-1
 * alpha-2 country catalog and the canonical raid-region mapping.
 *
 * Why local: the /pingsetup builder, the raid region detector (regionMap.js)
 * and the raid alert embeds (raidStateManager.countryCodeToName) must agree on
 * every country code, its human-readable name and its broad region. Keeping the
 * full catalog + mapping in ONE local file (never a remote API at runtime)
 * means the builder keeps working even if an external service is unavailable,
 * and the builder can never disagree with the detector.
 *
 * Region keys are the canonical set used everywhere:
 *   ASIA, EU, NA, SA, OCEANIA, AFRICA, MIDDLE_EAST
 *
 * The catalog contains every ISO 3166-1 alpha-2 code (including dependent
 * territories) because the raid detectors (RoValra datacenter list and
 * ip-api.com) can return any of them as an ISO-2 country code.
 */

// [code, English name (ASCII), canonical region]
const COUNTRIES = [
  ['AF', 'Afghanistan', 'ASIA'],
  ['AX', 'Aland Islands', 'EU'],
  ['AL', 'Albania', 'EU'],
  ['DZ', 'Algeria', 'AFRICA'],
  ['AS', 'American Samoa', 'OCEANIA'],
  ['AD', 'Andorra', 'EU'],
  ['AO', 'Angola', 'AFRICA'],
  ['AI', 'Anguilla', 'NA'],
  ['AQ', 'Antarctica', 'OCEANIA'],
  ['AG', 'Antigua and Barbuda', 'NA'],
  ['AR', 'Argentina', 'SA'],
  ['AM', 'Armenia', 'MIDDLE_EAST'],
  ['AW', 'Aruba', 'NA'],
  ['AU', 'Australia', 'OCEANIA'],
  ['AT', 'Austria', 'EU'],
  ['AZ', 'Azerbaijan', 'MIDDLE_EAST'],
  ['BS', 'Bahamas', 'NA'],
  ['BH', 'Bahrain', 'MIDDLE_EAST'],
  ['BD', 'Bangladesh', 'ASIA'],
  ['BB', 'Barbados', 'NA'],
  ['BY', 'Belarus', 'EU'],
  ['BE', 'Belgium', 'EU'],
  ['BZ', 'Belize', 'NA'],
  ['BJ', 'Benin', 'AFRICA'],
  ['BM', 'Bermuda', 'NA'],
  ['BQ', 'Bonaire, Sint Eustatius and Saba', 'NA'],
  ['BT', 'Bhutan', 'ASIA'],
  ['BO', 'Bolivia', 'SA'],
  ['BA', 'Bosnia and Herzegovina', 'EU'],
  ['BW', 'Botswana', 'AFRICA'],
  ['BV', 'Bouvet Island', 'AFRICA'],
  ['BR', 'Brazil', 'SA'],
  ['IO', 'British Indian Ocean Territory', 'ASIA'],
  ['VG', 'British Virgin Islands', 'NA'],
  ['BN', 'Brunei', 'ASIA'],
  ['BG', 'Bulgaria', 'EU'],
  ['BF', 'Burkina Faso', 'AFRICA'],
  ['BI', 'Burundi', 'AFRICA'],
  ['CV', 'Cape Verde', 'AFRICA'],
  ['KH', 'Cambodia', 'ASIA'],
  ['CM', 'Cameroon', 'AFRICA'],
  ['CA', 'Canada', 'NA'],
  ['KY', 'Cayman Islands', 'NA'],
  ['CF', 'Central African Republic', 'AFRICA'],
  ['TD', 'Chad', 'AFRICA'],
  ['CL', 'Chile', 'SA'],
  ['CN', 'China', 'ASIA'],
  ['CX', 'Christmas Island', 'OCEANIA'],
  ['CC', 'Cocos (Keeling) Islands', 'OCEANIA'],
  ['CO', 'Colombia', 'SA'],
  ['KM', 'Comoros', 'AFRICA'],
  ['CG', 'Congo (Brazzaville)', 'AFRICA'],
  ['CD', 'Congo (Kinshasa)', 'AFRICA'],
  ['CK', 'Cook Islands', 'OCEANIA'],
  ['CR', 'Costa Rica', 'NA'],
  ['CI', "Cote d'Ivoire", 'AFRICA'],
  ['HR', 'Croatia', 'EU'],
  ['CU', 'Cuba', 'NA'],
  ['CW', 'Curacao', 'NA'],
  ['CY', 'Cyprus', 'MIDDLE_EAST'],
  ['CZ', 'Czechia', 'EU'],
  ['DK', 'Denmark', 'EU'],
  ['DJ', 'Djibouti', 'AFRICA'],
  ['DM', 'Dominica', 'NA'],
  ['DO', 'Dominican Republic', 'NA'],
  ['EC', 'Ecuador', 'SA'],
  ['EG', 'Egypt', 'AFRICA'],
  ['SV', 'El Salvador', 'NA'],
  ['GQ', 'Equatorial Guinea', 'AFRICA'],
  ['ER', 'Eritrea', 'AFRICA'],
  ['EE', 'Estonia', 'EU'],
  ['SZ', 'Eswatini', 'AFRICA'],
  ['ET', 'Ethiopia', 'AFRICA'],
  ['FK', 'Falkland Islands', 'SA'],
  ['FO', 'Faroe Islands', 'EU'],
  ['FJ', 'Fiji', 'OCEANIA'],
  ['FI', 'Finland', 'EU'],
  ['FR', 'France', 'EU'],
  ['GF', 'French Guiana', 'SA'],
  ['PF', 'French Polynesia', 'OCEANIA'],
  ['TF', 'French Southern Territories', 'AFRICA'],
  ['GA', 'Gabon', 'AFRICA'],
  ['GM', 'Gambia', 'AFRICA'],
  ['GE', 'Georgia', 'MIDDLE_EAST'],
  ['DE', 'Germany', 'EU'],
  ['GH', 'Ghana', 'AFRICA'],
  ['GI', 'Gibraltar', 'EU'],
  ['GR', 'Greece', 'EU'],
  ['GL', 'Greenland', 'NA'],
  ['GD', 'Grenada', 'NA'],
  ['GP', 'Guadeloupe', 'NA'],
  ['GU', 'Guam', 'OCEANIA'],
  ['GT', 'Guatemala', 'NA'],
  ['GG', 'Guernsey', 'EU'],
  ['GN', 'Guinea', 'AFRICA'],
  ['GW', 'Guinea-Bissau', 'AFRICA'],
  ['GY', 'Guyana', 'SA'],
  ['HT', 'Haiti', 'NA'],
  ['HM', 'Heard Island and McDonald Islands', 'OCEANIA'],
  ['HN', 'Honduras', 'NA'],
  ['HK', 'Hong Kong', 'ASIA'],
  ['HU', 'Hungary', 'EU'],
  ['IS', 'Iceland', 'EU'],
  ['IN', 'India', 'ASIA'],
  ['ID', 'Indonesia', 'ASIA'],
  ['IR', 'Iran', 'MIDDLE_EAST'],
  ['IQ', 'Iraq', 'MIDDLE_EAST'],
  ['IE', 'Ireland', 'EU'],
  ['IM', 'Isle of Man', 'EU'],
  ['IL', 'Israel', 'MIDDLE_EAST'],
  ['IT', 'Italy', 'EU'],
  ['JM', 'Jamaica', 'NA'],
  ['JP', 'Japan', 'ASIA'],
  ['JE', 'Jersey', 'EU'],
  ['JO', 'Jordan', 'MIDDLE_EAST'],
  ['KZ', 'Kazakhstan', 'ASIA'],
  ['KE', 'Kenya', 'AFRICA'],
  ['KI', 'Kiribati', 'OCEANIA'],
  ['KP', 'North Korea', 'ASIA'],
  ['KR', 'South Korea', 'ASIA'],
  ['XK', 'Kosovo', 'EU'],
  ['KW', 'Kuwait', 'MIDDLE_EAST'],
  ['KG', 'Kyrgyzstan', 'ASIA'],
  ['LA', 'Laos', 'ASIA'],
  ['LV', 'Latvia', 'EU'],
  ['LB', 'Lebanon', 'MIDDLE_EAST'],
  ['LS', 'Lesotho', 'AFRICA'],
  ['LR', 'Liberia', 'AFRICA'],
  ['LY', 'Libya', 'AFRICA'],
  ['LI', 'Liechtenstein', 'EU'],
  ['LT', 'Lithuania', 'EU'],
  ['LU', 'Luxembourg', 'EU'],
  ['MO', 'Macao', 'ASIA'],
  ['MG', 'Madagascar', 'AFRICA'],
  ['MW', 'Malawi', 'AFRICA'],
  ['MY', 'Malaysia', 'ASIA'],
  ['MV', 'Maldives', 'ASIA'],
  ['ML', 'Mali', 'AFRICA'],
  ['MT', 'Malta', 'EU'],
  ['MH', 'Marshall Islands', 'OCEANIA'],
  ['MQ', 'Martinique', 'NA'],
  ['MR', 'Mauritania', 'AFRICA'],
  ['MU', 'Mauritius', 'AFRICA'],
  ['YT', 'Mayotte', 'AFRICA'],
  ['MX', 'Mexico', 'NA'],
  ['FM', 'Micronesia', 'OCEANIA'],
  ['MD', 'Moldova', 'EU'],
  ['MC', 'Monaco', 'EU'],
  ['MN', 'Mongolia', 'ASIA'],
  ['ME', 'Montenegro', 'EU'],
  ['MS', 'Montserrat', 'NA'],
  ['MA', 'Morocco', 'AFRICA'],
  ['MZ', 'Mozambique', 'AFRICA'],
  ['MM', 'Myanmar', 'ASIA'],
  ['NA', 'Namibia', 'AFRICA'],
  ['NR', 'Nauru', 'OCEANIA'],
  ['NP', 'Nepal', 'ASIA'],
  ['NL', 'Netherlands', 'EU'],
  ['NC', 'New Caledonia', 'OCEANIA'],
  ['NZ', 'New Zealand', 'OCEANIA'],
  ['NI', 'Nicaragua', 'NA'],
  ['NE', 'Niger', 'AFRICA'],
  ['NG', 'Nigeria', 'AFRICA'],
  ['NU', 'Niue', 'OCEANIA'],
  ['NF', 'Norfolk Island', 'OCEANIA'],
  ['MK', 'North Macedonia', 'EU'],
  ['MP', 'Northern Mariana Islands', 'OCEANIA'],
  ['NO', 'Norway', 'EU'],
  ['OM', 'Oman', 'MIDDLE_EAST'],
  ['PK', 'Pakistan', 'ASIA'],
  ['PW', 'Palau', 'OCEANIA'],
  ['PS', 'Palestine', 'MIDDLE_EAST'],
  ['PA', 'Panama', 'NA'],
  ['PG', 'Papua New Guinea', 'OCEANIA'],
  ['PY', 'Paraguay', 'SA'],
  ['PE', 'Peru', 'SA'],
  ['PH', 'Philippines', 'ASIA'],
  ['PN', 'Pitcairn Islands', 'OCEANIA'],
  ['PL', 'Poland', 'EU'],
  ['PT', 'Portugal', 'EU'],
  ['PR', 'Puerto Rico', 'NA'],
  ['QA', 'Qatar', 'MIDDLE_EAST'],
  ['RE', 'Reunion', 'AFRICA'],
  ['RO', 'Romania', 'EU'],
  ['RU', 'Russia', 'EU'],
  ['RW', 'Rwanda', 'AFRICA'],
  ['BL', 'Saint Barthelemy', 'NA'],
  ['SH', 'Saint Helena', 'AFRICA'],
  ['KN', 'Saint Kitts and Nevis', 'NA'],
  ['LC', 'Saint Lucia', 'NA'],
  ['MF', 'Saint Martin', 'NA'],
  ['PM', 'Saint Pierre and Miquelon', 'NA'],
  ['VC', 'Saint Vincent and the Grenadines', 'NA'],
  ['WS', 'Samoa', 'OCEANIA'],
  ['SM', 'San Marino', 'EU'],
  ['ST', 'Sao Tome and Principe', 'AFRICA'],
  ['SA', 'Saudi Arabia', 'MIDDLE_EAST'],
  ['SN', 'Senegal', 'AFRICA'],
  ['RS', 'Serbia', 'EU'],
  ['SC', 'Seychelles', 'AFRICA'],
  ['SL', 'Sierra Leone', 'AFRICA'],
  ['SG', 'Singapore', 'ASIA'],
  ['SX', 'Sint Maarten', 'NA'],
  ['SK', 'Slovakia', 'EU'],
  ['SI', 'Slovenia', 'EU'],
  ['SB', 'Solomon Islands', 'OCEANIA'],
  ['SO', 'Somalia', 'AFRICA'],
  ['ZA', 'South Africa', 'AFRICA'],
  ['GS', 'South Georgia and the South Sandwich Islands', 'SA'],
  ['SS', 'South Sudan', 'AFRICA'],
  ['ES', 'Spain', 'EU'],
  ['LK', 'Sri Lanka', 'ASIA'],
  ['SD', 'Sudan', 'AFRICA'],
  ['SR', 'Suriname', 'SA'],
  ['SJ', 'Svalbard and Jan Mayen', 'EU'],
  ['SE', 'Sweden', 'EU'],
  ['CH', 'Switzerland', 'EU'],
  ['SY', 'Syria', 'MIDDLE_EAST'],
  ['TW', 'Taiwan', 'ASIA'],
  ['TJ', 'Tajikistan', 'ASIA'],
  ['TZ', 'Tanzania', 'AFRICA'],
  ['TH', 'Thailand', 'ASIA'],
  ['TL', 'Timor-Leste', 'ASIA'],
  ['TG', 'Togo', 'AFRICA'],
  ['TK', 'Tokelau', 'OCEANIA'],
  ['TO', 'Tonga', 'OCEANIA'],
  ['TT', 'Trinidad and Tobago', 'NA'],
  ['TN', 'Tunisia', 'AFRICA'],
  ['TR', 'Turkey', 'MIDDLE_EAST'],
  ['TM', 'Turkmenistan', 'ASIA'],
  ['TC', 'Turks and Caicos Islands', 'NA'],
  ['TV', 'Tuvalu', 'OCEANIA'],
  ['UG', 'Uganda', 'AFRICA'],
  ['UA', 'Ukraine', 'EU'],
  ['AE', 'United Arab Emirates', 'MIDDLE_EAST'],
  ['GB', 'United Kingdom', 'EU'],
  ['US', 'United States', 'NA'],
  ['UM', 'United States Minor Outlying Islands', 'OCEANIA'],
  ['VI', 'United States Virgin Islands', 'NA'],
  ['UY', 'Uruguay', 'SA'],
  ['UZ', 'Uzbekistan', 'ASIA'],
  ['VU', 'Vanuatu', 'OCEANIA'],
  ['VA', 'Vatican City', 'EU'],
  ['VE', 'Venezuela', 'SA'],
  ['VN', 'Vietnam', 'ASIA'],
  ['WF', 'Wallis and Futuna', 'OCEANIA'],
  ['EH', 'Western Sahara', 'AFRICA'],
  ['YE', 'Yemen', 'MIDDLE_EAST'],
  ['ZM', 'Zambia', 'AFRICA'],
  ['ZW', 'Zimbabwe', 'AFRICA'],
  ];

/** Canonical raid regions, display order. `key` must match the raid detector. */
const REGIONS = [
  { key: 'ASIA', label: 'Asia', emoji: '🌏' },
  { key: 'EU', label: 'Europe', emoji: '🇪🇺' },
  { key: 'NA', label: 'North America', emoji: '🌎' },
  { key: 'SA', label: 'South America', emoji: '🌎' },
  { key: 'OCEANIA', label: 'Oceania', emoji: '🌏' },
  { key: 'AFRICA', label: 'Africa', emoji: '🌍' },
  { key: 'MIDDLE_EAST', label: 'Middle East', emoji: '🏜️' }
];

/** code -> { code, name, region } (values are frozen snapshots). */
const COUNTRIES_BY_CODE = new Map();
/** name (UPPERCASED, trimmed) -> region — used by the RoValra name detector. */
const COUNTRY_NAME_TO_REGION = new Map();
/** code -> canonical region (uppercased code). */
const COUNTRY_CODE_TO_REGION = new Map();

for (const [code, name, region] of COUNTRIES) {
  const entry = Object.freeze({ code, name, region });
  COUNTRIES_BY_CODE.set(code, entry);
  COUNTRY_NAME_TO_REGION.set(name.trim().toUpperCase(), region);
  COUNTRY_CODE_TO_REGION.set(code.toUpperCase(), region);
}

/** Country list sorted by English name (stable; used by the paginated builder). */
const COUNTRIES_SORTED = [...COUNTRIES_BY_CODE.values()].sort((a, b) =>
  a.name.localeCompare(b.name)
);

/**
 * Returns the regional-indicator flag emoji for an ISO-3166 alpha-2 code
 * (e.g. 'IN' -> 🇮🇳). Returns a plain flag for unknown/non-renderable codes.
 * @param {string} code
 * @returns {string}
 */
function flagEmoji(code) {
  const cc = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '🏳️';
  return cc.replace(/./g, (c) => String.fromCodePoint(0x1f1e6 + (c.charCodeAt(0) - 65)));
}

/**
 * Looks up a country entry by ISO-3166 alpha-2 code (case-insensitive).
 * @param {string} code
 * @returns {{ code: string, name: string, region: string }|null}
 */
function getCountry(code) {
  const cc = String(code || '').trim().toUpperCase();
  return cc ? (COUNTRIES_BY_CODE.get(cc) || null) : null;
}

/**
 * Resolves a country code to its canonical raid region (case-insensitive).
 * @param {string} code
 * @returns {string|null}
 */
function getRegionForCountryCode(code) {
  const cc = String(code || '').trim().toUpperCase();
  return cc ? (COUNTRY_CODE_TO_REGION.get(cc) || null) : null;
}

/**
 * Resolves a country NAME (as returned by RoValra / ip-api) to its canonical
 * raid region. Case-insensitive.
 * @param {string} name
 * @returns {string|null}
 */
function getRegionForCountryName(name) {
  const key = String(name || '').trim().toUpperCase();
  return key ? (COUNTRY_NAME_TO_REGION.get(key) || null) : null;
}

/**
 * Human-readable label for a canonical region key ('ASIA' -> 'Asia').
 * @param {string} regionKey
 * @returns {string}
 */
function regionLabel(regionKey) {
  for (const region of REGIONS) {
    if (region.key === String(regionKey || '').trim().toUpperCase()) return region.label;
  }
  return String(regionKey || '').trim();
}

module.exports = {
  COUNTRIES,
  REGIONS,
  COUNTRIES_BY_CODE,
  COUNTRIES_SORTED,
  COUNTRY_CODE_TO_REGION,
  COUNTRY_NAME_TO_REGION,
  flagEmoji,
  getCountry,
  getCountryName(code) {
    const entry = getCountry(code);
    return entry ? entry.name : null;
  },
  getRegionForCountryCode,
  getRegionForCountryName,
  regionLabel
};