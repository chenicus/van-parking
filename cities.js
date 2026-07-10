// City registry. Park Daddy is multi-city: the "current city" is simply whichever
// city's bounds contain the map center. Each city declares its data feeds, how those
// render (point meters vs blockface lines), and how to bias address search.
//
// Datasets are geographically disjoint, so all loaded cities' blocks can live in one
// array — the label layer filters by viewport regardless of origin.
export const CITIES = {
  vancouver: {
    name: 'Vancouver',
    center: [49.2606, -123.114], zoom: 13,
    bounds: [[49.19, -123.28], [49.33, -123.02]],   // [[south, west], [north, east]]
    data: [
      { url: 'data/meters.json', kind: 'meters' },
      { url: 'data/free.json', kind: 'free' },
    ],
    style: 'points',
    geo: { cc: 'ca', suffix: 'Vancouver, BC' },
  },
  seattle: {
    name: 'Seattle',
    center: [47.6062, -122.3321], zoom: 14,
    bounds: [[47.49, -122.44], [47.74, -122.23]],
    data: [
      { url: 'data/seattle-meters.json?v=2', kind: 'seattle' },
      { url: 'data/seattle-free.json?v=1', kind: 'seattle-free' },
    ],
    style: 'lines',
    geo: { cc: 'us', suffix: 'Seattle, WA' },
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
