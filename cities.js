// City registry. Park Daddy is multi-city: the "current city" is simply whichever
// city's bounds contain the map center. Each city declares its data feeds, how those
// render (point meters vs blockface lines), and how to bias address search.
//
// Datasets are geographically disjoint, so all loaded cities' blocks can live in one
// array — the label layer filters by viewport regardless of origin.
//
// `name` / `region` / `flag` / `added` are what the UI reads: every city list in the app
// (first-run picker, menu, the coverage sentence) is built from this object, so a city
// can't appear in one and be missing from another. San Jose shipped absent from the
// first-run picker for nine days because that list was hand-maintained markup.
//
// `picker: false` is the one intentional exception: the city is fully supported — search
// resolves there, the map draws it, the menu lists it as covered — it just isn't offered
// as a "pick your city" destination. That list is for somewhere you'd choose to go; a few
// blocks of one downtown is somewhere you're already standing, and it earns its way in
// through search instead. Coverage claims (the menu, the coverage sentence, the page
// title) deliberately ignore this flag — they'd be lying otherwise.
export const CITIES = {
  vancouver: {
    name: 'Vancouver', region: 'British Columbia, Canada', flag: '🇨🇦', added: '2026-07-06',
    center: [49.2606, -123.114], zoom: 13,
    bounds: [[49.19, -123.28], [49.33, -123.02]],   // [[south, west], [north, east]]
    data: [
      { url: 'data/meters.json', kind: 'meters' },
      { url: 'data/free.json', kind: 'free' },
    ],
    style: 'points',
    rank: true,   // only city with the point-meter feed rankMeters() understands (walk-cost spot suggestions)
    geo: { cc: 'ca', suffix: 'Vancouver, BC' },
  },
  seattle: {
    name: 'Seattle', region: 'Washington, USA', flag: '🇺🇸', added: '2026-07-10',
    center: [47.6062, -122.3321], zoom: 14,
    bounds: [[47.49, -122.44], [47.74, -122.23]],
    data: [
      { url: 'data/seattle-meters.json?v=2', kind: 'seattle' },
      { url: 'data/seattle-free.json?v=1', kind: 'seattle-free' },
    ],
    style: 'lines',
    geo: { cc: 'us', suffix: 'Seattle, WA' },
  },
  sf: {
    name: 'San Francisco', region: 'California, USA', flag: '🇺🇸', added: '2026-07-11',
    center: [37.7749, -122.4194], zoom: 13,
    bounds: [[37.70, -122.53], [37.84, -122.35]],
    data: [
      { url: 'data/sf-meters.json?v=1', kind: 'sf' },
      { url: 'data/sf-free.json?v=1', kind: 'sf-free' },
    ],
    // Point meters (drawn as dots, like Vancouver) but priced by time-of-day bands (like
    // Seattle's demand-responsive shape). No `rank`: its meters carry rate bands, not the
    // Vancouver rate fields rankMeters() reads, so we frame on the destination without suggestions.
    // The free layer is blockface LINES (Seattle's shape) — so SF draws both dots and lines.
    // It's time-limited blocks only; SF publishes no unrestricted-parking feed (build-sf-free.py).
    style: 'points',
    geo: { cc: 'us', suffix: 'San Francisco, CA' },
  },
  sanjose: {
    picker: false,
    name: 'San Jose', region: 'California, USA', flag: '🇺🇸', added: '2026-07-13',
    center: [37.3352, -121.8895], zoom: 15,
    bounds: [[37.30, -121.94], [37.38, -121.85]],
    data: [
      { url: 'data/sanjose-meters.json?v=1', kind: 'sanjose' },
    ],
    // Flat-rate point meters ($2/hr Mon–Sat 9–6, free Sun) — same points+bands shape as SF.
    // No `rank`: bands, not the Vancouver rate fields rankMeters() reads. Compact downtown
    // footprint, so a tighter default zoom (15) than the larger cities.
    style: 'points',
    geo: { cc: 'us', suffix: 'San Jose, CA' },
  },
  kirkland: {
    picker: false,
    name: 'Kirkland', region: 'Washington, USA', flag: '🇺🇸', added: '2026-07-13',
    center: [47.6764, -122.2065], zoom: 16,
    bounds: [[47.65, -122.22], [47.70, -122.18]],
    data: [
      { url: 'data/kirkland-meters.json?v=1', kind: 'kirkland' },
    ],
    // Point stalls + bands like San Jose ($1/hr on paid faces, free-but-time-limited elsewhere),
    // but every stall has an occupancy sensor — `live` is the ArcGIS query endpoint app.js polls
    // for real-time vacant/occupied, the one city where the map shows LIVE availability. Compact
    // downtown waterfront footprint, so a tight default zoom (16). No `rank`: bands, not the
    // Vancouver rate fields rankMeters() reads.
    live: 'https://services2.arcgis.com/loGMwowmR0OPlOQb/arcgis/rest/services/Kirkland_Parking_Sensors__wStatus/FeatureServer/0/query',
    style: 'points',
    geo: { cc: 'us', suffix: 'Kirkland, WA' },
  },
};

// Which city (key) contains this point, or null if outside every coverage box.
export function cityAt(lat, lon) {
  for (const [key, c] of Object.entries(CITIES)) {
    const [[s, w], [n, e]] = c.bounds;
    if (lat >= s && lat <= n && lon >= w && lon <= e) return key;
  }
  return null;
}

export const DEFAULT_CITY = 'vancouver';

// Keys to badge NEW: the most recently added batch only, and only while it's still recent.
// A badge on three of four rows points at nothing — this always marks the smallest set
// that's actually newer than the rest, and stops marking anything once nothing is.
const NEW_FOR_DAYS = 30;
export function newCities(now = new Date()) {
  const dates = Object.values(CITIES).map((c) => c.added).filter(Boolean).sort();
  const newest = dates[dates.length - 1];
  if (!newest) return new Set();
  if ((now - new Date(newest + 'T00:00:00')) / 86400000 > NEW_FOR_DAYS) return new Set();
  return new Set(Object.keys(CITIES).filter((k) => CITIES[k].added === newest));
}
