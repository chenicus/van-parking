import { rankMeters, rateNow, limitNow, bandRateNow, distMeters, ENF_START, MID, ENF_END, prohibitionWindowsForDay, prohibitionNow } from './rank.js?v=15';
import { buildBlocks, buildSeattleBlocks, buildSeattleFreeBlocks, buildSFBlocks, buildSanJoseBlocks, buildKirklandBlocks, createLabelLayer, fmtLimit, bucket } from './labels.js?v=36';
import { CITIES, cityAt, DEFAULT_CITY, newCities } from './cities.js?v=11';
import { createDriving, SIM_START } from './driving.js?v=29';
import { fetchRoute, createNav, fmtDist } from './nav.js?v=16';
import { fetchFlags, submitReport, submitFeedback, rptKey, FLAG_MIN, HIDE_MIN } from './reports.js?v=3';
import { CHANGELOG } from './changelog.js?v=3';
import { track } from './analytics.js?v=3';

const $ = (id) => document.getElementById(id);
const TOPN = 5;
let meters = [];
const filters = { free: true, paid: true };
let map, markers = [], destMarker, lastLoc = null, cachedPos = null;

const params = new URLSearchParams(location.search);
if (params.get('dest')) $('dest').value = params.get('dest');
// ---- trip: when you'll arrive + how long you'll stay -------------------------
// clockMins() is the real wall clock (or the ?t= mock). The trip's ARRIVAL can
// differ from it — you can plan for a destination's drive-time ETA or a set time.
// Everything downstream (price pills, spot card, ranking) reads nowMins(), which
// resolves to the trip arrival, so a planned arrival re-prices the whole map.
// ?t=HH:MM mocks the clock (rate-flip testing); ?wknd=1 forces weekend limits.
const mockT = (() => {
  const m = (params.get('t') || '').match(/^([0-9]{1,2}):([0-9]{2})$/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
})();
// Wall-clock time in the CITY on screen, NOT the viewer's device. Parking rates flip on
// the local hour and day, so "now" has to be the city's now: a friend in Lisbon looking
// at Seattle was getting Seattle priced against Portugal's clock — eight hours ahead, so
// mid-afternoon Seattle read as evening and the whole map showed free. Each city carries
// a `tz`; we pull the parts through Intl in that zone. The active city is whichever
// coverage box holds the map center (kept current on every moveend).
function cityTz() { return (CITIES[activeCity] || CITIES[DEFAULT_CITY]).tz || 'America/Los_Angeles'; }
function cityParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: cityTz(), hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;   // some engines render midnight as '24' under hour12:false
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, hour, min: +p.minute, dow };
}
function clockMins() {
  if (mockT != null) return mockT;
  const p = cityParts(); return p.hour * 60 + p.min;
}
// fixed assumed stay length (hours) — no longer user-set; used only to rank spots
// (rush-hour tow-away overlap) when a destination is searched
const trip = { mode: 'now', durH: 2, etaMins: null, setMins: null, setDate: null, userSet: false };
function todayStr() { const p = cityParts(); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
function arrivalMins() {
  if (trip.mode === 'set' && trip.setMins != null) return trip.setMins;
  if (trip.mode === 'eta' && trip.etaMins != null) return trip.etaMins;
  return clockMins();
}
function nowMins() { return arrivalMins(); }
function durationMins() { return Math.min(trip.durH, 13) * 60; }
function isWeekend() {
  if (params.get('wknd')) return true;
  if (trip.mode === 'set' && trip.setDate) {
    const [y, m, d] = trip.setDate.split('-').map(Number);
    const day = new Date(y, m - 1, d).getDay();
    return day === 0 || day === 6;
  }
  const day = cityParts().dow; return day === 0 || day === 6;
}
// Day-of-week for Seattle's per-day rate bands (0=Sun … 6=Sat). ?dow=N overrides for
// testing (e.g. ?dow=0 to see Sunday's free-everywhere), ?wknd=1 stands in for Saturday.
function dowNow() {
  if (params.get('dow') != null) return +params.get('dow');
  if (params.get('wknd')) return 6;
  if (trip.mode === 'set' && trip.setDate) {
    const [y, m, d] = trip.setDate.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }
  return cityParts().dow;
}

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Safe localStorage: some browsers (blocked cookies, hardened privacy modes, embedded webviews)
// THROW on access. This runs at module-eval time, so an unguarded read here would abort the whole
// script before any UI boots. Every access goes through here.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
// CARTO's free, no-API-key VECTOR styles — Positron (light) / Dark Matter (dark). Vector so the
// map can truly rotate/pitch and MapLibre keeps street labels upright; near-identical muted look
// to the old raster basemaps. Attribution rides inside each style's sources → shown by the
// built-in AttributionControl, so we don't hand-roll it.
const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const initTheme = (store.get('pd_theme') || (darkMedia.matches ? 'dark' : 'light'));
let curStyle = STYLES[initTheme === 'dark' ? 'dark' : 'light'];
map = new maplibregl.Map({
  container: 'map',
  style: curStyle,
  center: [-123.114, 49.2606],   // [lng, lat] — note the order flip from Leaflet
  zoom: 13,
  attributionControl: { compact: true },
  // dragRotate + touchZoomRotate are on by default → two-finger rotate and pan-at-bearing.
  pitchWithRotate: true,
});
// resolves once the map is first usable; map-touching bootstrap awaits this.
let mapReady = false;
const mapLoaded = new Promise((res) => map.on('load', () => {
  mapReady = true; installLayers(); res();
  // tells the boot splash the map is painted; flag covers the case where the
  // splash script initialises after this fires
  window.__pdMapReady = true;
  document.dispatchEvent(new Event('pd:map-ready'));
}));

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
// All custom sources/layers live here. setStyle (theme swap) wipes them, so this is re-run on
// every 'style.load'. HTML markers (pills/pin/car) are NOT part of the style and survive.
function installLayers() {
  if (!map.getSource('blockface-lines')) map.addSource('blockface-lines', { type: 'geojson', data: EMPTY_FC });
  if (!map.getLayer('blockface-lines')) map.addLayer({
    id: 'blockface-lines', type: 'line', source: 'blockface-lines', layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['step', ['zoom'], 3, 14, 4, 16, 5],
      'line-opacity': ['step', ['zoom'], 0.35, 14, 0.42, 16, 0.5] },
  });
  if (!map.getSource('meter-dots')) map.addSource('meter-dots', { type: 'geojson', data: EMPTY_FC });
  if (!map.getLayer('meter-dots')) map.addLayer({
    id: 'meter-dots', type: 'circle', source: 'meter-dots',
    paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['step', ['zoom'], 3, 15, 2.5, 16, 3.5],
      'circle-opacity': ['step', ['zoom'], 0.6, 15, 0.4, 16, 0.9] },
  });
  if (!map.getSource('spot-line')) map.addSource('spot-line', { type: 'geojson', data: EMPTY_FC });
  if (!map.getLayer('spot-line')) map.addLayer({
    id: 'spot-line', type: 'line', source: 'spot-line', layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#1a1a1a', 'line-width': 3, 'line-opacity': 0.7, 'line-dasharray': [1, 3] },
  });
  if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: EMPTY_FC });
  if (!map.getLayer('route-casing')) map.addLayer({
    id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': 10, 'line-opacity': 0.85 },
  });
  if (!map.getLayer('route')) map.addLayer({
    id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1e1e20', 'line-width': 6 },
  });
}
// A theme swap (setStyle) wipes all custom sources/layers, and MapLibre v4 does NOT fire
// 'style.load' on setStyle — and the interim 'styledata' events fire before the style is
// actually ready (isStyleLoaded false). So re-install whenever the style IS ready and our
// sentinel layer is gone; 'idle' guarantees a ready style after a swap. The getLayer guard
// means all the routine events (our own setData, camera settles) skip straight through — no
// refresh loop and no redundant work.
function ensureLayers() {
  if (!map.isStyleLoaded() || map.getLayer('meter-dots')) return;
  installLayers();
  if (labelLayer) labelLayer.refresh();       // re-push meter dots + blockface lines
  if (nav) nav.redraw();                       // re-push the active route line (its source was emptied)
  if (cardBlock) drawSpotLine(cardBlock);      // re-push the open spot's dashed connector line
}
map.on('styledata', ensureLayers);
map.on('idle', ensureLayers);

// Theme swap: reload the whole vector style (positron ⇄ dark-matter). style.load re-installs our
// layers; the View-Transition circular wipe (applyTheme) covers the reload visually.
function setTiles() {
  const url = STYLES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
  if (url === curStyle) return;
  curStyle = url;
  map.setStyle(url);
}

// ---- Theme (light/dark) ----------------------------------------------------
// Follows the OS by default; a manual choice via #themetoggle is persisted and wins.
const THEME_KEY = 'pd_theme';
// Lucide sun / moon — the icon shows the mode you'd switch TO (sun in dark, moon in light).
const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const tc = document.getElementById('themeColor');
  if (tc) tc.setAttribute('content', theme === 'dark' ? '#000000' : '#ffffff');
  const tt = document.getElementById('themetoggle');
  if (tt) tt.innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;  // shows the mode you'd switch TO
  setTiles();
}
// ?theme=dark|light forces a theme (handy for previewing / sharing a link); otherwise use the
// saved preference, then fall back to the OS setting.
const forcedTheme = params.get('theme');
applyTheme((forcedTheme === 'dark' || forcedTheme === 'light')
  ? forcedTheme
  : (store.get(THEME_KEY) || (darkMedia.matches ? 'dark' : 'light')));
darkMedia.addEventListener('change', () => {
  if (!store.get(THEME_KEY)) applyTheme(darkMedia.matches ? 'dark' : 'light');
});
document.getElementById('themetoggle')?.addEventListener('click', (e) => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const swap = () => { store.set(THEME_KEY, next); applyTheme(next); };

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Circular wipe from the button's center; falls back to an instant swap where
  // the View Transitions API is unavailable (older Safari/Firefox) or motion is off.
  if (!document.startViewTransition || reduce) { swap(); return; }

  const r = e.currentTarget.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // Backdrop-filter is dropped inside view-transition snapshots, so the frosted
  // .mat chrome would flash its translucent bg over the sharp pills mid-wipe.
  // Make those surfaces near-opaque for the duration (present in both snapshots).
  document.documentElement.classList.add('theming');
  const vt = document.startViewTransition(swap);
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
      { duration: 500, easing: 'cubic-bezier(.36,.66,.3,1)', pseudoElement: '::view-transition-new(root)' }
    );
  });
  vt.finished.finally(() => document.documentElement.classList.remove('theming'));
});

// free-parking blocks derived from enforcement data (build-free.py) → pseudo-blocks
// that ride the same pill/filter/card machinery as meters, but always read as FREE.
let freeBlocks = [];
function buildFreeBlocks(arr) {
  return arr.map((f, i) => ({
    id: 1e6 + i, lat: f.lat, lon: f.lon, isFree: true, hblock: f.h, tickets: f.n,
    rate1: null, rate2: null, flat: null,
    limits: { day: 180, eve: null, wkndDay: 180, wkndEve: null },
    rushes: [], pts: [], count: 0, spaces: 0, card: false,
  }));
}

// Multi-city: the current city is whichever CITIES bounds contain the map center. We
// lazy-load a city's feeds the first time you're there (on open via geolocation, or on
// pan/search into it), pushing its blocks into the shared `blocks` array.
let activeCity = DEFAULT_CITY;
// Set once the first-visit picker sends us somewhere: it suppresses the best-effort geolocation
// recenter below so an incoming GPS fix can't yank the map off the city the user just tapped.
let cityChosen = false;

// Boot-UI gate. The location permission sheet must not appear until the splash has
// driven off AND the city picker (when shown) is resolved — stacking a native
// permission dialog on top of the picker is disruptive, and if the user then taps a
// city the fix gets discarded anyway. initWelcome() below owns opening this gate.
let openBootGate;
const bootUISettled = new Promise((res) => { openBootGate = res; });
// resolves once the boot splash has removed itself (immediately if there isn't one)
const splashCleared = () =>
  (window.__pdSplashDone || !document.getElementById('pdSplash'))
    ? Promise.resolve()
    : new Promise((r) => document.addEventListener('pd:splash-done', r, { once: true }));
const loadedCities = new Set();
function pushBlocks(arr) { for (const b of arr) blocks.push(b); }

// Fly to a city and load its feeds. Used by the first-visit picker (#welcome).
async function goToCity(key) {
  const c = CITIES[key];
  if (!c) return;
  cityChosen = true;
  track('city_switched', { city: key });
  activeCity = key;
  await mapLoaded;
  activeCity = key;   // re-assert: the boot IIFE resolves off mapLoaded first and sets DEFAULT_CITY
  map.jumpTo({ center: [c.center[1], c.center[0]], zoom: c.zoom });
  // Passive follow (started in initLiveLabels) eases the camera onto every GPS fix inside ANY
  // covered city — which yanks the map straight back off the city you just picked. Picking a city
  // is an explicit "show me over there", so park follow like a search does; the recenter fab
  // (visible whenever follow is off) takes you back to yourself.
  driving?.setFollow(false);
  await loadCity(key);
  driving?.setFollow(false);   // again: `driving` is created inside loadCity on the first city
}

async function loadCity(key) {
  if (loadedCities.has(key)) return;
  loadedCities.add(key);
  const c = CITIES[key];
  try {
    const feeds = await Promise.all(c.data.map((d) => fetch(d.url).then((r) => r.json()).catch(() => [])));
    c.data.forEach((d, i) => {
      const data = feeds[i] || [];
      if (d.kind === 'meters') { meters = data; pushBlocks(buildBlocks(data)); }
      else if (d.kind === 'free') { freeBlocks = buildFreeBlocks(data); pushBlocks(freeBlocks); }
      else if (d.kind === 'seattle') { pushBlocks(buildSeattleBlocks(data)); }
      else if (d.kind === 'seattle-free') { pushBlocks(buildSeattleFreeBlocks(data)); }
      else if (d.kind === 'sf') { pushBlocks(buildSFBlocks(data)); }
      else if (d.kind === 'sf-free') { pushBlocks(buildSeattleFreeBlocks(data, 7e6)); }
      else if (d.kind === 'sanjose') { pushBlocks(buildSanJoseBlocks(data)); }
      else if (d.kind === 'kirkland') { const kb = buildKirklandBlocks(data); pushBlocks(kb); startKirkLive(kb, c.live); }
    });
    if (!labelLayer) initLiveLabels();          // first city: stand up the whole layer
    else labelLayer.refresh();                  // later cities: just repaint
  } catch { loadedCities.delete(key); setStatus('Failed to load parking data.'); }
}

// ---- Kirkland live occupancy --------------------------------------------------
// Kirkland is the one city with an in-ground stall-sensor feed. We poll its ArcGIS query
// endpoint for each stall's vacant/occupied status, join by stall name onto the pre-built
// faces, and repaint — so dots turn green/grey live and pills/cards show "N free". Polling is
// gated to a foreground tab actually looking at Kirkland, so panning away or backgrounding the
// tab costs nothing; the feed itself is ~500 tiny rows.
let kirkBlocks = [], kirkByName = null, kirkLiveUrl = null, kirkTimer = null, kirkFetching = false;
function startKirkLive(blocksArr, liveUrl) {
  kirkBlocks = blocksArr;
  kirkLiveUrl = liveUrl || null;
  kirkByName = new Map();
  for (const b of kirkBlocks) for (const s of b.stalls) if (s.n) kirkByName.set(s.n, { b, s });
  if (!kirkLiveUrl || kirkTimer) { pollKirkLive(); return; }
  pollKirkLive();
  kirkTimer = setInterval(() => {
    if (document.hidden) return;                              // don't poll a backgrounded tab
    const ctr = map.getCenter();
    if (cityAt(ctr.lat, ctr.lng) === 'kirkland') pollKirkLive();
  }, 45000);
  // returning to the tab while on Kirkland → refresh immediately rather than waiting out the interval
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const ctr = map.getCenter();
    if (cityAt(ctr.lat, ctr.lng) === 'kirkland') pollKirkLive();
  });
}
async function pollKirkLive() {
  if (!kirkLiveUrl || !kirkByName || kirkFetching) return;
  kirkFetching = true;
  const url = kirkLiveUrl + '?where=' + encodeURIComponent('In_Service=1') +
    '&outFields=stall_name,status&returnGeometry=false&f=json';
  let feats;
  try { feats = (await fetch(url).then((r) => r.json())).features || []; }
  catch { kirkFetching = false; return; }                    // network hiccup — keep the last-known counts
  finally { kirkFetching = false; }
  for (const b of kirkBlocks) { b._free = 0; b._tot = 0; for (const s of b.stalls) s.s = null; }
  for (const f of feats) {
    const a = f.attributes || {};
    const hit = kirkByName.get(a.stall_name);
    if (!hit) continue;
    const st = a.status === 'vacant' ? 'vacant' : a.status === 'occupied' ? 'occupied' : null;
    hit.s.s = st;
    hit.b._tot++;
    if (st === 'vacant') hit.b._free++;
  }
  const ts = Date.now();
  for (const b of kirkBlocks) b.avail = b._tot ? { free: b._free, total: b._tot, ts } : null;
  if (labelLayer) labelLayer.refresh();
  if (cardBlock && cardBlock.kirk) showSpotCard(cardBlock);  // keep an open card's counts fresh
}

// Open on a city immediately, then best-effort recenter on the user. We deliberately do NOT
// block the first paint on geolocation: the browser's permission prompt has no timeout until
// the user answers, so awaiting a fix can hang the boot skeleton forever if the prompt is
// ignored (common at a red light). Paint the default city first; if a fix lands within a few
// seconds and it's in a covered city, pan there.
(async () => {
  await mapLoaded;   // MapLibre isn't usable until 'load' — unlike Leaflet's synchronous map

  // The welcome picker is up before the map finishes loading, so a tap can land while we're still
  // parked on this await. goToCity() then owns the camera and the city load — bail out rather than
  // paint DEFAULT_CITY over it (which also clobbered activeCity, mis-biasing search and ranking).
  if (cityChosen) return;

  // Deep link with explicit coords: honor it exactly — no geolocation needed. Guard against a
  // malformed/truncated share link (?lat=abc): a NaN center makes MapLibre throw and, inside this
  // un-caught boot IIFE, would leave the skeleton up forever — so fall through to the default city.
  // NOTE: require the raw params to be PRESENT before coercing — `+null` and `+''` are both 0
  // (a finite number), so an ordinary no-params open would otherwise take this branch and fly to
  // [0,0] (null island), stranding a "Dropped pin" on a blank ocean. That was the blank-map bug.
  const rawLat = params.get('lat'), rawLon = params.get('lon');
  const plat = +rawLat, plon = +rawLon;
  if (rawLat && rawLon && Number.isFinite(plat) && Number.isFinite(plon)) {
    const key = cityAt(plat, plon) || DEFAULT_CITY;
    activeCity = key;
    map.jumpTo({ center: [plon, plat], zoom: 16 });   // MapLibre wants [lng, lat]
    await loadCity(key);
    run({ lat: plat, lon: plon, name: params.get('dest') || 'Dropped pin' }, true);
    return;
  }

  // Paint the default city now so pills show right away. Passive drive mode (see
  // initLiveLabels) recenters the camera on the user once GPS warms up; here we only detect +
  // load the RIGHT city's data. c.center is Leaflet [lat, lon]; MapLibre wants [lng, lat].
  const c = CITIES[DEFAULT_CITY];
  activeCity = DEFAULT_CITY;
  map.jumpTo({ center: [c.center[1], c.center[0]], zoom: c.zoom });
  await loadCity(DEFAULT_CITY);

  if (params.get('dest')) { run(null, true); return; }   // text-search deep link

  // Hold the permission prompt until the splash is gone and the picker is answered,
  // so the boot reads: animation -> map -> city picker -> location prompt.
  await bootUISettled;
  // They just told us which city they're in, and the fix below would be discarded by
  // the cityChosen guard regardless — so don't spend a permission prompt on it.
  if (cityChosen) return;

  // Best-effort recenter, capped at 5s so a slow or ignored permission prompt never stalls boot.
  const pos = await Promise.race([
    getPosition().catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);
  if (!pos) return;
  if (cityChosen) return;                                // user picked a city in the welcome — respect it
  const key = cityAt(pos.lat, pos.lon);
  if (!key) return;                                      // outside coverage — stay on the default city
  if (key !== activeCity) { activeCity = key; await loadCity(key); }
  map.easeTo({ center: [pos.lon, pos.lat], zoom: 16, duration: reduceMotion() ? 0 : 600 });
})();

function setStatus(msg) { toast(msg, 4000); }

// ---- geolocation + drive-time ETA -------------------------------------------
function getPosition() {
  return new Promise((res) => {
    if (cachedPos) return res(cachedPos);
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { cachedPos = { lat: p.coords.latitude, lon: p.coords.longitude }; res(cachedPos); },
      () => res(null), { timeout: 8000, maximumAge: 60000 }
    );
  });
}
// ---- geocode ----------------------------------------------------------------
// Search spans every covered country; the city you're looking at is a *bias* (viewbox),
// not a filter — so a bare "Main St" resolves locally, but "gum wall seattle" still jumps
// to Seattle even while you're viewing Vancouver.
const GEO_CCS = [...new Set(Object.values(CITIES).map((c) => c.geo.cc))].join(',');
// Pull the coarse place fields out of a Nominatim hit. City / state / country are kept
// SEPARATE rather than pre-joined so callers can decide how much to show — displayPlace()
// needs to compare the state against the city to know whether it adds anything.
// Deliberately never reads a.road / a.house_number: we don't want the street.
function placeFields(hit) {
  const a = hit.address || {};
  return {
    lat: parseFloat(hit.lat), lon: parseFloat(hit.lon),
    city: a.city || a.town || a.village || a.municipality || a.county || null,
    state: a.state || a.province || a.region || null,
    country: a.country || null,
  };
}
async function geocodeOne(q, biased) {
  // addressdetails: only so an out-of-coverage hit can be named ("not in Portland yet").
  // We read the town/state/country fields, never the street or house number.
  const p = new URLSearchParams({ format: 'json', limit: '1', addressdetails: '1', countrycodes: GEO_CCS, q });
  if (biased) {
    const [[s, w], [n, e]] = (CITIES[activeCity] || CITIES[DEFAULT_CITY]).bounds;
    p.set('viewbox', `${w},${s},${e},${n}`);   // soft bias toward the current city (bounded=0)
  }
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + p.toString(), { headers: { 'Accept-Language': 'en' } });
  // Nominatim is a free shared server; under load it returns 429/503. Flag those
  // as `busy` so run() can tell "server rate-limited us" from "place not found".
  if (!r.ok) { const e = new Error('geocode ' + r.status); e.busy = r.status === 429 || r.status === 503; throw e; }
  const j = await r.json();
  if (!j.length) return null;
  return { ...placeFields(j[0]), name: j[0].display_name };
}
// Last-resort lookup with the country filter OFF, used ONLY when the normal search finds
// nothing. It answers "does this place exist somewhere we don't cover?" so a Berlin or
// Sydney search can say "not available there yet" instead of the misleading "couldn't find
// that place". addressdetails gives us the town/country to name in the message — we read
// only those coarse fields, never the road or house number.
async function geocodeAnywhere(q) {
  const p = new URLSearchParams({ format: 'json', limit: '1', addressdetails: '1', q });
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + p.toString(), { headers: { 'Accept-Language': 'en' } });
  if (!r.ok) return null;                       // best-effort: a failure here just falls back to "not found"
  const j = await r.json();
  if (!j.length) return null;
  return placeFields(j[0]);
}
// Try local-biased first, then widen to any covered city if that finds nothing.
async function geocodeWide(q) { return (await geocodeOne(q, true)) || geocodeOne(q, false); }
async function geocode(q) {
  let loc = await geocodeWide(q);
  if (!loc && /\s(&|and|at|@|\/|x)\s|\s?&\s?/i.test(q)) {
    const first = q.split(/\s*(?:&|@|\/|\bat\b|\band\b|\bx\b)\s*/i)[0].trim();
    if (first) loc = await geocodeWide(first);
  }
  return loc;
}
// google.com/maps links are registered as a universal/app link by the Google Maps app on
// both iOS and Android, so this deep-links straight into the installed app (the vast
// majority of phones) instead of opening in the browser; only falls back to the website
// when Google Maps itself isn't installed.
const navUrl = (r) => `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}&travelmode=driving`;
const NAV_SVG = '<svg viewBox="0 0 24 24"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>';
// Lucide (shadcn) inline icons — inherit color via currentColor.
const IC = {
  clock: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  alert: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  dollar: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>',
  info: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
};
function clearMap() { markers.forEach((m) => m.remove()); markers = []; }

// ---- crowd reports ("this spot is wrong") -----------------------------------
// flags: rptKey -> { count, items[] }. Drives the pill warning badge / auto-hide
// (labels.js) and the spot-card report banner + list.
let flags = new Map();
function flagFor(b) { return flags.get(rptKey(b)); }
function flagState(b) {
  const c = flagFor(b)?.count || 0;
  return { flagged: c >= FLAG_MIN, hidden: c >= HIDE_MIN };
}
async function loadFlags() {
  flags = await fetchFlags();
  if (labelLayer) labelLayer.refresh();
}

const REASONS_FREE = [
  { code: 'not_free', label: 'Not actually free' },
  { code: 'permit', label: 'Sign says permit only' },
  { code: 'no_parking', label: 'No parking here' },
  { code: 'other', label: 'Other' },
];
const REASONS_PAID = [
  { code: 'rate_wrong', label: 'Rate is wrong' },
  { code: 'permit', label: 'Sign says permit only' },
  { code: 'no_parking', label: 'No parking here' },
  { code: 'other', label: 'Other' },
];
const REASON_LABEL = {
  not_free: 'Not actually free', rate_wrong: 'Rate is wrong', permit: 'Sign says permit only',
  no_parking: 'No parking here', other: 'Other',
};
const reasonText = (r) => r.reason === 'other' ? (r.detail || 'Other') : (REASON_LABEL[r.reason] || r.reason);
const PHOTO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';
const CAMERA_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';

// "1100 ALBERNI ST" -> "1100 block Alberni St"; null for metered blocks (no street on record)
function blockLabel(b) {
  if (!b.hblock) return null;
  const parts = String(b.hblock).trim().split(/\s+/);
  const num = /^\d+$/.test(parts[0]) ? parts.shift() : null;
  const street = parts.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return num ? `${num} block ${street}` : street;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function reportRow(r) {
  const photo = safePhotoUrl(r.photo_url);
  const hasPhoto = !!photo || r.photo_url === '#local';   // '#local' = local-dev stub, no URL
  const thumb = photo
    ? `<a class="rp-thumb" href="${esc(photo)}" target="_blank" rel="noopener"><img src="${esc(photo)}" alt="sign photo"></a>`
    : `<span class="rp-thumb ph">${PHOTO_SVG}</span>`;
  const sub = (hasPhoto ? 'Photo attached · ' : '') + timeAgo(r.created_at);
  return `<div class="rp-item">${thumb}<div class="rp-txt">` +
    `<div class="rp-reason">${esc(reasonText(r))}</div><div class="rp-sub">${esc(sub)}</div></div></div>`;
}

const CHEV_R = '<svg class="fl-chev" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

// spot card shows a one-line summary; the full list lives in the slide-in #reportlist panel
function renderFlag(b) {
  const f = flagFor(b);
  const banner = $('scflag');
  if (!f) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.innerHTML = `${IC.alert}<span class="fl-txt"><b>${f.count} report${f.count > 1 ? 's' : ''}</b> say this may be wrong</span>${CHEV_R}`;
  // prime the detail panel (opened on tap)
  $('rlSub').textContent = b._label || (b.isFree ? 'Free spot' : 'Metered spot');
  $('rlList').innerHTML = f.items.map(reportRow).join('');
}
// Opening the list drops the spot card and raises the list in its place — the same swap
// the menu does with What's new. Back reverses it. The `cardBlock` guard is what keeps
// closeSpotCard() from resurrecting the card: it nulls cardBlock before calling this.
function openReportList() {
  $('spotcard').hidden = true;
  $('reportlist').classList.add('open');
}
function closeReportList() {
  const wasOpen = $('reportlist').classList.contains('open');
  $('reportlist').classList.remove('open');
  if (wasOpen && cardBlock) $('spotcard').hidden = false;
}

let current = [];
async function run(preLoc, isNew) {
  const q = $('dest').value.trim();
  if (!q && !preLoc) return;
  let loc = preLoc;
  if (!loc) {
    $('searchform').classList.add('loading');
    try { loc = await geocode(q); }
    catch (e) {
      setStatus(e.busy
        ? 'Search is busy right now — wait a moment and try again.'
        : 'Search is unavailable — check your connection and try again.');
      return;
    } finally { $('searchform').classList.remove('loading'); }
  }
  // Nothing in a covered country — but the place may still exist elsewhere. Check before
  // claiming we couldn't find it, so "Berlin" gets "not available there yet" and only a
  // genuine typo gets "couldn't find that".
  if (!loc) {
    const away = await geocodeAnywhere(q);
    if (away) { showNoCoverage(away); return; }
    setStatus('Could not find that place. Try an address or nearby landmark.');
    return;
  }
  // Resolved inside the US or Canada, but outside the five metros we have data for —
  // Portland, Toronto, anywhere. Without this the map would rank the CURRENT city's
  // meters against a destination hundreds of miles away and present it as a real answer.
  if (!cityAt(loc.lat, loc.lon)) { showNoCoverage(loc); return; }
  driving?.setFollow(false);   // searching = looking elsewhere; let the map rest on the destination
  lastLoc = loc;
  addRecent(loc, q);
  trip.userSet = false;   // a fresh destination re-arms the "arrive on arrival" default
  rankAndRender(loc);
  // shape only, never the query itself: it's usually a real address (see analytics.js)
  track('destination_searched', { city: activeCity, results: current.length, typed: !preLoc });
  resolveEta(loc);
}

// ---- recent destinations -----------------------------------------------------
// Persisted list of places you've searched — surfaced when the search box is
// focused so you can jump back without re-typing. Newest first, capped at 5.
const REC_KEY = 'vanpark.recents', REC_MAX = 5;
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Crowd reports are written by anyone (open Supabase insert). photo_url is later rendered as an
// <a href> + <img src>, so a stored `javascript:…` URL would run on click, and any 3rd-party URL
// would beacon every viewer's IP. Only accept https photos on Supabase storage; reject the rest.
function safePhotoUrl(u) {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    if (url.protocol === 'https:' && /(^|\.)supabase\.co$/.test(url.hostname)) return url.href;
  } catch {}
  return null;
}

// Drop malformed entries (partial writes, hand-edits, old schema) so addRecent/renderRecents
// never throw on a missing .label or non-numeric coords.
function loadRecents() {
  try {
    const a = JSON.parse(store.get(REC_KEY));
    return Array.isArray(a) ? a.filter((r) => r && typeof r.label === 'string'
      && Number.isFinite(r.lat) && Number.isFinite(r.lon)) : [];
  } catch { return []; }
}
function saveRecents(a) { store.set(REC_KEY, JSON.stringify(a)); }

// prefer what the user typed as the label; fall back to the geocoder's first segment
function addRecent(loc, q) {
  const label = (q && q.trim()) || (loc.name || '').split(',')[0].trim();
  if (!label || label === 'My location') return;   // "here" searches aren't a destination
  const a = loadRecents().filter((r) =>
    r.label.toLowerCase() !== label.toLowerCase() &&
    !(Math.abs(r.lat - loc.lat) < 1e-4 && Math.abs(r.lon - loc.lon) < 1e-4));
  a.unshift({ label, lat: loc.lat, lon: loc.lon });
  saveRecents(a.slice(0, REC_MAX));
}

function renderRecents() {
  const a = loadRecents();
  $('rcHead').hidden = false;
  $('rcList').innerHTML = a.map((r, i) =>
    `<div class="rc-item" data-i="${i}"><span class="rc-ic">${PIN_SVG}</span>` +
    `<span class="rc-txt"><span class="rc-name">${esc(r.label)}</span></span>` +
    `<button class="rc-del" type="button" data-del="${i}" aria-label="Remove">${X_SVG}</button></div>`
  ).join('');
  return a.length;
}
function showRecents() { suggestSeq++; if (renderRecents()) $('recents').hidden = false; else $('recents').hidden = true; }
function hideRecents() { $('recents').hidden = true; }

// ---- live suggestions (autocomplete) ----------------------------------------
// As you type, query Photon (komoot's autocomplete geocoder — CORS-enabled) and list
// matches in the same panel. Each match already carries its coordinates, so picking one
// searches directly with no second geocode. We bias to the map center (not a hard bbox)
// so local streets rank first while an explicit "gum wall seattle" still surfaces.
let suggestSeq = 0, suggestTimer = null, suggestItems = [];

// Country of the city currently on screen — the stand-in for "where the user is", which is
// what Google keys its domestic/foreign rule on. Photon spells countries out, so compare
// against the same spelling it returns.
const CC_NAME = { ca: 'Canada', us: 'United States' };
// Display-only rename, applied after the domestic comparison above so the matching still
// works on Photon's own string. Google Maps writes "USA"; everywhere else it spells out.
const COUNTRY_DISPLAY = { 'United States': 'USA' };
const viewerCountry = () => CC_NAME[(CITIES[activeCity] || CITIES[DEFAULT_CITY]).geo.cc] || '';

function featToSuggest(f) {
  const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
  if (!c) return null;
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ');
  if (!name) return null;
  const n = (s) => String(s || '').toLowerCase().trim();
  // Secondary line, following Google's own address formatting: street (only when it isn't
  // already the title), then city, state, country — fine to coarse, no district, no
  // postcode. Country is dropped when it's the viewer's own, which is why Google shows
  // "Victoria, British Columbia" but "Portland, Oregon, USA" to the same Canadian user.
  const foreignCountry = p.country && n(p.country) !== n(viewerCountry()) ? p.country : null;
  let parts = [p.name && p.street ? p.street : null, p.city, p.state, foreignCountry]
    .filter(Boolean)
    .filter((v) => n(v) !== n(name))                                   // don't echo the title
    .filter((v, i, a) => a.findIndex((x) => n(x) === n(v)) === i);     // "Singapore, Singapore"
  // Over three parts, the street is the first to go: it's the least useful thing for telling
  // two same-named places apart, and keeping it would push the country off the end of the
  // ellipsis — the exact reason a hit in Minsk read as though it were around the corner.
  if (parts.length > 3) parts = parts.slice(1);
  const sub = parts.slice(0, 3).map((v) => COUNTRY_DISPLAY[v] || v).join(', ');
  return { label: name, sub, lat: c[1], lon: c[0] };
}

function renderSuggest(items) {
  suggestItems = items;
  $('rcHead').hidden = true;
  if (!items.length) { hideRecents(); return; }
  $('rcList').innerHTML = items.map((s, i) =>
    `<div class="rc-item" data-s="${i}"><span class="rc-ic">${PIN_SVG}</span>` +
    `<span class="rc-txt"><span class="rc-name">${esc(s.label)}</span>` +
    (s.sub ? `<span class="rc-sub">${esc(s.sub)}</span>` : '') + `</span></div>`
  ).join('');
  $('recents').hidden = false;
}

async function fetchSuggest(q) {
  const seq = ++suggestSeq;
  const ctr = map.getCenter();   // bias toward where you're looking, no hard boundary
  const url = `https://photon.komoot.io/api/?limit=6&lang=en` +
    `&lat=${ctr.lat}&lon=${ctr.lng}&q=${encodeURIComponent(q)}`;
  let feats;
  try { feats = (await fetch(url).then((r) => r.json())).features || []; }
  catch { return; }                       // network hiccup — leave the panel as-is
  if (seq !== suggestSeq) return;         // a newer keystroke (or a clear) superseded this
  if ($('dest').value.trim().length < 2) return;
  // Collapse rows that would render identically. Photon returns Singapore the country, the
  // city and the island as three separate hits with every address field null — three rows a
  // person cannot tell apart or choose between. Google dedupes on the displayed strings for
  // the same reason; the first hit wins because Photon already ranks them.
  const seen = new Set();
  const items = feats.map(featToSuggest).filter(Boolean).filter((s) => {
    const key = s.label + '|' + s.sub;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  renderSuggest(items);
}

// typing drives the panel: <2 chars → recents, otherwise debounced suggestions
function onType() {
  const q = $('dest').value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 2) { showRecents(); return; }
  suggestTimer = setTimeout(() => fetchSuggest(q), 250);
}
$('dest').addEventListener('input', onType);
$('dest').addEventListener('focus', () => { $('dest').value.trim().length >= 2 ? onType() : showRecents(); });

// custom clear button (replaces the native search cancel button so it centers cleanly)
function updateClear() { $('clearDest').hidden = $('dest').value.length === 0; }
$('dest').addEventListener('input', updateClear);
$('clearDest').addEventListener('click', () => {
  $('dest').value = '';
  $('dest').focus();
  onType();          // 0 chars → drops back to recents
  updateClear();
});
updateClear();       // sync on load (a prefilled ?dest= should show the X)
// keep the panel open until you pick, clear, or tap away — not on every input blur
document.addEventListener('click', (e) => {
  if ($('recents').hidden) return;
  if (e.target.closest('#recents') || e.target.closest('#searchform')) return;
  hideRecents();
});
document.addEventListener('click', (e) => {
  if ($('tripcard').hidden) return;
  if (e.target.closest('#tripcard') || e.target.closest('#tripPill')) return;
  $('tripcard').hidden = true;
}, true);
$('rcList').addEventListener('click', (e) => {
  const del = e.target.closest('.rc-del');
  if (del) {
    e.stopPropagation();   // rebuilding the list detaches this node — keep the outside-click closer from firing
    const a = loadRecents(); a.splice(+del.dataset.del, 1); saveRecents(a);
    if (!renderRecents()) hideRecents();
    return;
  }
  const item = e.target.closest('.rc-item');
  if (!item) return;
  // a suggestion carries its own coords; a recent is looked up by index
  const pick = item.dataset.s != null ? suggestItems[+item.dataset.s] : loadRecents()[+item.dataset.i];
  if (!pick) return;
  $('dest').value = pick.label;
  updateClear();
  $('dest').blur();
  hideRecents();
  run({ lat: pick.lat, lon: pick.lon, name: pick.label }, true);
});
$('rcClear').addEventListener('click', () => { saveRecents([]); hideRecents(); });

// Get the drive-time ETA to the destination and, unless the user picked an arrival
// themselves, default the trip to "arrive on arrival". Silently no-ops without a
// location fix or on a routing failure — the ETA segment just stays hidden.
async function resolveEta(loc) {
  const pos = cachedPos || await getPosition();
  if (!pos) return;
  let r;
  try { r = await fetchRoute(pos, loc); } catch { return; }
  trip.etaMins = (((clockMins() + Math.round(r.duration / 60)) % 1440) + 1440) % 1440;
  $('tcEta').hidden = false;
  $('tcEta').textContent = fmtClock(trip.etaMins);   // e.g. "6:20pm" — the "Arrive" label carries the meaning
  if (!trip.userSet) trip.mode = 'eta';
  syncTrip();
}

function rankAndRender(loc) {
  const arrival = nowMins();
  const duration = durationMins(), maxWalkMin = 10;
  // Meter-ranking (walk-cost, spot suggestions) is Vancouver-only for now — it reads the
  // point-meter feed. In line-style cities we just frame on the destination.
  const rankable = CITIES[activeCity] && CITIES[activeCity].rank && meters.length;
  const ranked = rankable ? rankMeters(meters, { lat: loc.lat, lon: loc.lon, arrival, duration, maxWalkMin, sort: 'cheap' }) : [];
  current = ranked.slice(0, 40);   // kept only to frame the map around nearby spots

  if (labelLayer) labelLayer.setSelected(null);
  clearSpotLine();
  if (destMarker) destMarker.remove();
  // indigo teardrop — a distinct SHAPE so no price-pill color can camouflage it. As an HTML
  // marker it renders above the GL dot/line layers and stays screen-upright on rotate;
  // anchor:'bottom' pins the tip to the coordinate.
  const dEl = document.createElement('div');
  dEl.innerHTML = '<div class="destpinwrap"><svg class="destpin" width="34" height="34" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div>';
  // Marker stacking (one shared context, DOM order otherwise): car chevron 900 > dest pin 600 >
  // selected pill 500 (labels.js) > plain pills. Was 3, which lost to the selected pill and hid
  // the very place you searched for.
  dEl.style.zIndex = '600';
  destMarker = new maplibregl.Marker({ element: dEl, anchor: 'bottom' })
    .setLngLat([loc.lon, loc.lat]).addTo(map);

  frameMap(loc, current);
}

// center on destination, keep the 3 closest spots in view (symmetric so dest stays centred)
function frameMap(loc, list) {
  const near = list.slice(0, 3);
  let dLat = 0.0016, dLon = 0.0022;
  for (const r of near) { dLat = Math.max(dLat, Math.abs(r.lat - loc.lat)); dLon = Math.max(dLon, Math.abs(r.lon - loc.lon)); }
  // MapLibre bounds are [[west,south],[east,north]] = [[lon-,lat-],[lon+,lat+]].
  const bounds = [[loc.lon - dLon, loc.lat - dLat], [loc.lon + dLon, loc.lat + dLat]];
  const opts = { padding: { top: 120, bottom: 40, left: 40, right: 40 }, maxZoom: 17 };
  // Ease into the destination instead of snapping; pills then drop in on moveend for a
  // clean arrival. Reduced-motion users get the old instant framing.
  if (reduceMotion()) map.fitBounds(bounds, { ...opts, animate: false });
  else map.fitBounds(bounds, { ...opts, duration: 900 });
}

// ---- misc controls ----------------------------------------------------------
$('here').addEventListener('click', async () => {
  // "Go to my location": re-arm follow so drive mode snaps back onto you.
  if (driving?.isActive() && driving.lastPos()) { driving.setFollow(true); return; }
  const pos = await getPosition();
  if (!pos) { toast('Could not get your location.'); return; }
  driving?.setFollow(true);              // arm follow for incoming fixes
  map.easeTo({ center: [pos.lon, pos.lat], zoom: 16, duration: reduceMotion() ? 0 : 600 });
});
$('searchform').addEventListener('submit', (e) => { e.preventDefault(); $('dest').blur(); hideRecents(); run(null, true); });

// ---- Free / Paid filters ------------------------------------------------------
function applyFilters() {
  if (labelLayer) labelLayer.setFilter(filters);
}
$('chipFree').addEventListener('click', () => { filters.free = !filters.free; $('chipFree').classList.toggle('on', filters.free); applyFilters(); });
$('chipPaid').addEventListener('click', () => {
  filters.paid = !filters.paid;
  $('chipPaid').classList.toggle('on', filters.paid);
  applyFilters();
  // First time someone hides paid to look at free-only, warn that free data is thin.
  if (!filters.paid && !store.get('freeWarnSeen')) {
    toast('Free-parking data is limited and may be out of date — always double-check the posted signs.', 7000);
    store.set('freeWarnSeen', '1');
  }
});

// ---- Trip: arrival + duration -------------------------------------------------
function updatePill() {
  let arr = trip.mode === 'eta' && trip.etaMins != null ? fmtClock(trip.etaMins)
    : trip.mode === 'set' && trip.setMins != null ? fmtClock(trip.setMins) : 'Now';
  if (trip.mode === 'set' && trip.setDate && trip.setDate !== todayStr()) {
    const [y, m, d] = trip.setDate.split('-').map(Number);
    arr = `${new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${arr}`;
  }
  $('tpArr').textContent = arr;
}
// slide the segmented-control highlight to sit under the active button
function moveSegInd() {
  const on = $('tcArr').querySelector('button.on'), ind = $('tcSegInd');
  if (!on || !ind) return;
  ind.style.width = on.offsetWidth + 'px';
  ind.style.transform = `translateX(${on.offsetLeft}px)`;
}
function syncSeg() {
  $('tcArr').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === trip.mode));
  $('tcSetrow').hidden = trip.mode !== 'set';
  moveSegInd();
}
// re-render everything the trip affects, WITHOUT reframing the map
function syncTrip() {
  updatePill(); syncSeg();
  if (labelLayer) labelLayer.refresh();           // pills reflect the arrival rate window
  if (cardBlock) showSpotCard(cardBlock);         // spot card totals reflect arrival + duration
}
// on the desktop row layout, anchor the dropdown under the pill instead of under the search bar
function positionTripcard() {
  const tc = $('tripcard');
  if (window.innerWidth < 760) { tc.style.left = ''; tc.style.top = ''; return; }
  const r = $('tripPill').getBoundingClientRect();
  tc.style.left = `${Math.round(r.left)}px`;
  tc.style.top = `${Math.round(r.bottom + 8)}px`;
}
$('tripPill').addEventListener('click', () => {
  $('tripcard').hidden = !$('tripcard').hidden;
  if (!$('tripcard').hidden) positionTripcard();
  requestAnimationFrame(moveSegInd);
});
requestAnimationFrame(moveSegInd);   // initial highlight position
$('tcClose').addEventListener('click', () => { $('tripcard').hidden = true; });
$('tcArr').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.hidden) return;
  trip.mode = btn.dataset.m; trip.userSet = true;
  if (trip.mode === 'set') {
    if (trip.setMins == null) trip.setMins = clockMins();
    if (trip.setDate == null) trip.setDate = todayStr();
    const t = $('tcTime');
    t.value = `${String(Math.floor(trip.setMins / 60)).padStart(2, '0')}:${String(trip.setMins % 60).padStart(2, '0')}`;
    $('tcDate').value = trip.setDate;
    $('tcDate').min = todayStr();
    syncTrip();
    t.focus();
    if (t.showPicker) { try { t.showPicker(); } catch {} }
  } else {
    syncTrip();
  }
});
$('tcTime').addEventListener('input', () => {
  const [h, m] = $('tcTime').value.split(':').map(Number);
  if (!isNaN(h)) { trip.setMins = h * 60 + (m || 0); trip.mode = 'set'; trip.userSet = true; syncTrip(); }
});
$('tcDate').addEventListener('input', () => {
  if ($('tcDate').value) { trip.setDate = $('tcDate').value; trip.mode = 'set'; trip.userSet = true; syncTrip(); }
});
updatePill();

// ---- live price labels + driving mode ----------------------------------------
let labelLayer = null, driving = null, cardBlock = null, cardOpenDist = null, preDrive = null;

// straight connector from the tapped spot to the searched destination (GL line source)
function setSpotLineData(fc) { const s = map.getSource('spot-line'); if (s) s.setData(fc); }
function drawSpotLine(b) {
  if (!lastLoc) { clearSpotLine(); return; }
  setSpotLineData({ type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: [[b.lon, b.lat], [lastLoc.lon, lastLoc.lat]] },
  }] });
}
function clearSpotLine() { setSpotLineData(EMPTY_FC); }
let nav = null, navTarget = null, blocks = [], lastRerouteT = 0;

// ---- map orientation: native MapLibre bearing (heading-up POV ⇄ north-up) -----
// MapLibre rotates the real map, so "orientation" is just a target bearing. In a driving/nav
// session, heading-up means bearing = the car's heading; north-up means bearing 0. driving.js
// owns the per-fix camera (center + bearing eased together); this only nudges the bearing when
// the mode changes (compass tap, drive on/off).
let orientMode = 'heading';   // 'heading' = POV (default) | 'north'
// Desired bearing for the current mode. north-up (or not in a session) → 0; heading-up → heading.
function desiredBearing() {
  const active = driving && driving.isActive();
  const p = driving && driving.lastPos();
  return (active && orientMode === 'heading' && p) ? p.hdg : 0;
}
// Re-point the map to the mode's bearing (and recenter if we're following). Smooth unless
// reduced-motion. Called on compass tap and drive/nav start/stop — NOT per fix (driving.js
// eases center+bearing together on every fix).
function applyOrientation() {
  if (driving && driving.isActive()) driving.reorient();
  else map.easeTo({ bearing: 0, duration: reduceMotion() ? 0 : 400 });   // browse / drive-off → north
}
// Google-Maps compass: the needle always points to true north (counter-rotate the icon by the
// map bearing), and the button surfaces whenever the map is turned off north in plain browse
// mode (in drive/nav it's always shown as the heading-up toggle).
const compassSvg = document.querySelector('#compass svg');
function syncCompass() {
  const b = map.getBearing();
  if (compassSvg) compassSvg.style.transform = `rotate(${-b}deg)`;
  document.body.classList.toggle('rotated', Math.abs(b) > 0.5);
}
map.on('rotate', syncCompass);
map.on('load', syncCompass);
// After a compass tap lands the map on its new bearing, carry the needle a few degrees past
// and let it settle — a snap that just stops dead reads like a jump cut. WAAPI transform wins
// over syncCompass's inline style while it runs, then hands back cleanly (same end angle).
function springCompass(fromBearing) {
  if (!compassSvg || !compassSvg.animate || reduceMotion()) return;
  const dir = Math.sign(fromBearing) || 1;   // overshoot the way the needle was already travelling
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    map.off('moveend', run);
    const b = -map.getBearing();
    compassSvg.animate([
      { transform: `rotate(${b}deg)` },
      { transform: `rotate(${b + dir * 8}deg)`, offset: .35 },
      { transform: `rotate(${b - dir * 2.5}deg)`, offset: .7 },
      { transform: `rotate(${b}deg)` },
    ], { duration: 460, easing: 'ease-out' });
  };
  map.once('moveend', run);
  setTimeout(run, 700);   // the tap may not move the map at all (already on-bearing)
}

// match a ranked meter back to its label-layer block (same rate/limit tuple, nearest)
const blockKey = (m) => [m.rate_9am_6pm, m.rate_6pm_10pm, m.flat_rate, m.time_limit_9am_6pm,
  m.time_limit_6pm_10pm, m.direction].join('|');
function blockForMeter(m) {
  const g = m.geo_point_2d, key = blockKey(m);
  let best = null, bd = Infinity;
  for (const b of blocks) {
    if (b.key !== key) continue;
    const d = distMeters(b.lat, b.lon, g.lat, g.lon);
    if (d < bd) { best = b; bd = d; }
  }
  return bd <= 60 ? best : null;
}

// ---- turn-by-turn -------------------------------------------------------------
async function startNav(target) {
  // Fires here (not just in the one-time warning dialog's "Use anyway" handler) so it still
  // counts every navigation start, not just a user's very first one — see nwStart below.
  track('navigation_started', { city: activeCity });
  closeSpotCard();   // full teardown (spot line + pill highlight), not just hide
  const dest = { lat: target.lat, lon: target.lon };
  const from = driving.lastPos() || (params.get('sim') ? SIM_START : await getPosition());
  if (!from) { toast('Could not get your location — opening Google Maps.'); window.open(navUrl(dest)); return; }
  toast('Finding route…', 1500);
  let r;
  try { r = await fetchRoute(from, dest); }
  catch { toast('Routing failed — opening Google Maps.'); window.open(navUrl(dest)); return; }
  navTarget = dest;
  clearMap();                       // search pins off; dest marker + price pills stay
  nav.begin(r);
  document.body.classList.add('nav');
  orientMode = 'heading';           // turn-by-turn is heading-up (POV) by default
  driving.setSimTrack(r.coords);
  if (!driving.isActive()) driving.start(); else driving.setFollow(true);
  driving.setNavMode(true);           // routing → high-accuracy GPS + wake lock
  onNavFix(from);
}

async function onNavFix(pos) {
  const p = nav.update(pos);
  if (!p || !navTarget) return;
  if (p.arrived || distMeters(pos.lat, pos.lon, navTarget.lat, navTarget.lon) < 25) { endNav(true); return; }
  // camera follow (center + heading-up bearing) is eased per fix inside driving.js
  $('nbarrow').textContent = p.step.arrow;
  $('nbdist').textContent = p.stepDist < 20 ? 'Now' : fmtDist(p.stepDist);
  $('nbtext').textContent = p.step.text;
  const eta = new Date(Date.now() + p.remainS * 1000);
  const eap = eta.getHours() >= 12 ? 'pm' : 'am';
  $('etamin').textContent = `${Math.max(1, Math.round(p.remainS / 60))} min`;
  $('etasub').textContent = ` · ${fmtDist(p.remainM)} · arrive ${eta.getHours() % 12 || 12}:${String(eta.getMinutes()).padStart(2, '0')}${eap}`;
  if (p.offRoute && Date.now() - lastRerouteT > 8000) {
    lastRerouteT = Date.now();
    toast('Rerouting…', 2000);
    try {
      const r = await fetchRoute(pos, navTarget);
      if (navTarget) { nav.begin(r); driving.setSimTrack(r.coords); }
    } catch {}
  }
}

function endNav(arrived) {
  if (!navTarget) return;
  navTarget = null;
  nav.clear();
  document.body.classList.remove('nav');
  driving.setNavMode(false);                   // back to passive follow — drop the wake lock
  applyOrientation();                          // nav off → un-rotate back to north-up
  if (arrived) toast('You’ve arrived — tap any price on the map to see spot details.', 7000);
}

let toastTimer = null;
function toast(msg, ms = 5000) {
  const t = $('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer);   // a prior toast's pending hide-timer must not hide this newer one
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms);
}


// Clock formatter for schedule ranges: 540 -> "9:00am", 1080 -> "6:00pm", 1350 -> "10:30pm".
// Always shows minutes so times line up in the schedule column.
const fmtClock = (m) => {
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + ':' + String(mm).padStart(2, '0') + (h >= 12 ? 'pm' : 'am');
};
// money for the spot card — always 2 decimals so the price column aligns ($2.00, $1.50)
const money = (r) => '$' + r.toFixed(2);
// "updated" freshness for Kirkland's live counts: <10s reads "just now", else Ns/Nm ago.
function liveAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  return Math.round(s / 60) + 'm ago';
}

// Full-day price schedule for a metered block: free before 9am, rate1 9am–6pm,
// rate2 6pm–10pm, free after 10pm — with adjacent windows merged when their rate AND
// time-limit match, so a flat all-day meter reads as one row but a meter whose limit
// changes at 6pm (e.g. 2h → 4h) splits so each window can show its own "Max Nh".
function daySegments(b, wknd, dow) {
  const rushes = b.rushes || [];
  const prohWins = prohibitionWindowsForDay(b, dow);   // today's [start, end, zone] no-park windows
  const rateAt = (m) => (m < ENF_START || m >= ENF_END) ? 0 : (m < MID ? (b.rate1 || 0) : (b.rate2 || 0));
  // no-park at m: a rush tow-away (true) or a prohibition zone (its name), else false
  const noParkAt = (m) => {
    if (rushes.some((r) => m >= r[0] && m < r[1])) return true;
    const w = prohWins.find(([s, e]) => m >= s && m < e);
    return w ? w[2] : false;
  };
  // cut the day at every window edge AND every no-park boundary, then classify
  // each slice by its midpoint so rush + prohibition windows carve "no parking" out of the rates
  const bounds = new Set([0, ENF_START, MID, ENF_END, 1440]);
  for (const r of rushes) {
    if (r[0] > 0 && r[0] < 1440) bounds.add(r[0]);
    if (r[1] > 0 && r[1] < 1440) bounds.add(r[1]);
  }
  for (const [s, e] of prohWins) {
    if (s > 0 && s < 1440) bounds.add(s);
    if (e > 0 && e < 1440) bounds.add(e);
  }
  const pts = [...bounds].sort((x, y) => x - y);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i], to = pts[i + 1], mid = (from + to) / 2;
    const np = noParkAt(mid);
    const tow = !!np;
    const zone = typeof np === 'string' ? np : null;   // prohibition reason (else it's a rush tow-away)
    const rate = tow ? 0 : rateAt(mid);
    const limit = (!tow && rate > 0) ? limitNow(b.limits, mid, wknd) : null;   // only paid windows carry a limit
    const last = segs[segs.length - 1];
    if (last && last.tow === tow && last.rate === rate && last.limit === limit && last.zone === zone) last.to = to;
    else segs.push({ from, to, rate, tow, limit, zone });
  }
  return segs;
}
// friendly label for a prohibition zone code shown in the schedule
const ZONE_LABEL = {
  'TOW-AWAY': 'Tow-away',
  'NO STOPPING': 'No stopping', 'LOADING ZONE': 'Loading zone', 'CVLZ': 'Commercial loading',
  'PASSENGER ZONE': 'Passenger only', 'PERMIT PARKING ONLY': 'Permit only', 'TAXI ZONE': 'Taxi only',
  'MILITARY ZONE': 'Military only', 'POLICE ZONE': 'Police only', 'TOUR BUS ZONE': 'Tour bus only',
  'AUTHORIZED VEHICLES ONLY': 'Authorized only',
};
const zoneLabel = (z) => ZONE_LABEL[z] || (z ? z[0] + z.slice(1).toLowerCase() : 'No parking');

// Seattle blockface schedule for today: paid inside each rate band, free in the gaps
// (before the first band, between bands, after the last — and all day Sunday). Free-but-
// time-limited blocks (no bands) collapse to one free row carrying the cap.
function seattleDaySegments(b, dow) {
  const arr = [...((dow === 0 ? b.bands.sun : dow === 6 ? b.bands.sat : b.bands.wkd) || [])]
    .sort((x, y) => x.s - y.s);
  const segs = [];
  let cursor = 0;
  for (const bd of arr) {
    if (bd.s > cursor) segs.push({ from: cursor, to: bd.s, rate: 0, limit: null });
    segs.push({ from: bd.s, to: bd.e, rate: bd.r, limit: bd.r ? b.limitMin : null });
    cursor = bd.e;
  }
  if (cursor < 1440) segs.push({ from: cursor, to: 1440, rate: 0, limit: b.freeLimit || null });
  if (!segs.length) segs.push({ from: 0, to: 1440, rate: 0, limit: b.freeLimit || null });
  // A band block (SF) can still carry scheduled tow-away windows; carve them over the rate rows
  // so the schedule reads "3–6pm Tow-away" instead of a price that isn't actually parkable.
  return carveProhibitions(segs, prohibitionWindowsForDay(b, dow));
}

// Overlay today's [start, end, zone] no-park windows onto a rate schedule: split at every window
// edge and mark each slice inside a window as tow (rate 0, zone label). Shared shape with
// daySegments' output (from/to/rate/tow/zone/limit) so renderSchedule handles both.
function carveProhibitions(segs, prohWins) {
  if (!prohWins.length) return segs;
  const bounds = new Set();
  for (const s of segs) { bounds.add(s.from); bounds.add(s.to); }
  for (const [s, e] of prohWins) { bounds.add(s); bounds.add(e); }
  const pts = [...bounds].sort((x, y) => x - y);
  const zoneAt = (m) => { const w = prohWins.find(([s, e]) => m >= s && m < e); return w ? w[2] : null; };
  const baseAt = (m) => segs.find((s) => m >= s.from && m < s.to) || { rate: 0, limit: null };
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i], to = pts[i + 1], mid = (from + to) / 2;
    const zone = zoneAt(mid);
    const base = baseAt(mid);
    const seg = zone
      ? { from, to, rate: 0, tow: true, zone, limit: null }
      : { from, to, rate: base.rate, tow: false, zone: null, limit: base.limit };
    const last = out[out.length - 1];
    if (last && last.tow === seg.tow && last.rate === seg.rate && last.limit === seg.limit && last.zone === seg.zone) last.to = to;
    else out.push(seg);
  }
  return out;
}

function segLabel(s) {
  if (s.from === 0 && s.to === 1440) return 'All day';
  if (s.from === 0) return 'Before ' + fmtClock(s.to);
  if (s.to === 1440) return 'After ' + fmtClock(s.from);
  return fmtClock(s.from) + '–' + fmtClock(s.to);
}

function renderSchedule(b, mins) {
  const el = $('scsched');
  const segs = b.bands ? seattleDaySegments(b, dowNow()) : daySegments(b, isWeekend(), dowNow());
  el.innerHTML = segs.map((s) => {
    const active = mins >= s.from && mins < s.to;
    const free = !s.tow && s.rate === 0;
    const cost = s.tow ? (s.zone ? zoneLabel(s.zone) : 'No parking') : (free ? 'Free' : `${money(s.rate)}/hr`);
    // paid windows show their own max stay inline; the active row is marked by highlight alone
    const lim = s.limit != null && s.limit !== Infinity ? ` <span class="lim">· Max ${fmtLimit(s.limit)}</span>` : '';
    return `<div class="seg ${s.tow ? 'tow' : ''} ${free ? 'free' : ''} ${active ? 'active' : ''}">` +
      `<span class="when">${segLabel(s)}${lim}</span><span class="cost">${cost}</span></div>`;
  }).join('');
  el.hidden = false;
}

// quick content crossfade when swapping spots while the card is already open
// (a fresh open is covered by the sheet's slide-up, so only flash when re-populating)
function flashSpotContent() {
  [$('scprice'), $('scsub'), $('scsched'), $('scrows')].forEach((el) => {
    if (el) el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 190, easing: 'cubic-bezier(.32,.72,0,1)' });
  });
}
function showSpotCard(b) {
  const wasOpen = !$('spotcard').hidden;
  cardBlock = b;
  closeReportList();
  closeMenu();
  const p = driving && driving.lastPos();
  cardOpenDist = p ? distMeters(p.lat, p.lon, b.lat, b.lon) : null;
  const mins = nowMins();

  // walk from the searched destination to this block (only meaningful after a search)
  if (lastLoc) {
    const dM = distMeters(lastLoc.lat, lastLoc.lon, b.lat, b.lon);
    const dist = dM < 1000 ? `${Math.round(dM)} m` : `${(dM / 1000).toFixed(1)} km`;
    $('scsub').textContent = `${Math.max(1, Math.round(dM / 80))} min walk · ${dist} away`;
    $('scsub').style.display = '';
  } else {
    $('scsub').style.display = 'none';
  }
  drawSpotLine(b);

  // crowd reports (if any) — banner + detail list; also stamp a label for reports
  b._label = blockLabel(b);
  renderFlag(b);

  // Rate is resolved before the isFree early-return below so the one analytics call
  // covers both card shapes — free-residential blocks return early and would otherwise
  // never be counted, which is exactly the population we most want to measure.
  const r = b.isFree
    ? { free: true, rate: 0 }
    : (b.bands ? bandRateNow(b.bands, mins, dowNow()) : rateNow(b.rate1, b.rate2, mins));
  // One breakdown dimension rather than a pile of booleans: 'residential' is Vancouver's
  // unmetered bylaw blocks, 'free_street' is curb that's never paid at any hour (most of
  // Seattle/SF, and 41 of Kirkland's 46 faces), 'metered' is everything with a rate —
  // `free` then says whether that meter happens to be free right now.
  //
  // Derived from the rate data rather than a builder-set flag on purpose: the two block
  // shapes (Vancouver's rate1/rate2 vs everyone else's day bands) both encode this
  // already, and a hand-set marker is one a new city's builder can silently forget.
  const everPaid = b.bands
    ? !!(b.bands.wkd?.length || b.bands.sat?.length || b.bands.sun?.length)
    : !!(b.rate1 > 0 || b.rate2 > 0 || b.flat > 0);
  const spotType = b.isFree ? 'residential' : (everPaid ? 'metered' : 'free_street');
  track('spot_opened', { city: activeCity, free: !!r.free, spot_type: spotType, from_search: !!lastLoc });

  // free residential block: unmetered, bylaw 3h limit — its own clean card
  if (b.isFree) {
    $('scsched').hidden = true;
    $('scprice').textContent = 'Free';
    $('scprice').classList.add('free');
    $('scrows').innerHTML = [
      `${IC.clock} Max stay <b>3h</b> · 8am–6pm`,
      `${IC.info} Residential street — no meter. Check posted signs.`,
    ].map((h) => `<div>${h}</div>`).join('');
    $('scmaps').href = navUrl(b);
    if (wasOpen) flashSpotContent();
    $('spotcard').hidden = false;
    if (labelLayer) labelLayer.setSelected(b.id);
    return;
  }

  $('scprice').innerHTML = r.free ? 'Free right now' : `${money(r.rate)}<span class="sc-unit">/hr</span>`;

  // full-day price breakdown so a "free right now" spot still shows its paid window
  renderSchedule(b, mins);

  const rows = [];
  if (b.flat != null) rows.push(`${IC.dollar} ${money(b.flat)} flat evening rate`);
  const dow = dowNow();
  // compact clock: drop :00 and share the meridiem across a range → "3–7pm"
  const short = (m) => {
    const h = Math.floor(m / 60) % 24, mm = m % 60;
    return { t: (h % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : ''), ap: h >= 12 ? 'pm' : 'am' };
  };
  const fmtWin = (a, z) => { const s = short(a), e = short(z); return (s.ap === e.ap ? s.t : s.t + s.ap) + '–' + e.t + e.ap; };
  // A prohibition active right now — rare via a pill tap (those are hidden while active) but
  // reachable by search; call it out plainly.
  const pNow = prohibitionNow(b, mins, dow);
  if (pNow) rows.push(`<span class="warn">${IC.alert} No parking now · ${zoneLabel(pNow)}</span>`);
  // Upcoming no-park within the ~2h stay: a rush tow-away OR a prohibition zone. The full-day
  // schedule already lists every window; this is the urgency nudge you can't scroll past.
  const STAY = 120;
  let soonest = null;   // [start, end, zoneOrNull]
  for (const r of (b.rushes || [])) if (r[0] > mins && r[0] - mins <= STAY && (!soonest || r[0] < soonest[0])) soonest = [r[0], r[1], null];
  for (const w of prohibitionWindowsForDay(b, dow)) if (w[0] > mins && w[0] - mins <= STAY && (!soonest || w[0] < soonest[0])) soonest = w;
  if (soonest && !pNow) {
    const reason = soonest[2] ? zoneLabel(soonest[2]) : 'tow-away';
    const soon = soonest[0] - mins <= 90 ? ` starts in ${soonest[0] - mins} min` : '';
    rows.push(`<span class="warn">${IC.alert} No parking ${fmtWin(soonest[0], soonest[1])} · ${reason}${soon}</span>`);
  }
  // Kirkland: live stall-sensor availability, pinned to the top of the rows
  if (b.kirk) {
    const a = b.avail;
    rows.unshift(a
      ? `<span class="live"><span class="live-dot ${a.free > 0 ? 'ok' : 'full'}"></span>` +
        `<b>${a.free}</b> of ${a.total} open <span class="live-ago">· live · ${liveAgo(a.ts)}</span></span>`
      : `${IC.info} Live availability unavailable right now`);
  }
  $('scrows').innerHTML = rows.map((h) => `<div>${h}</div>`).join('');
  $('scmaps').href = navUrl(b);
  if (wasOpen) flashSpotContent();
  $('spotcard').hidden = false;
  if (labelLayer) labelLayer.setSelected(b.id);
}
function closeSpotCard() {
  $('spotcard').hidden = true; cardBlock = null; clearSpotLine(); closeReportList();
  if (labelLayer) labelLayer.setSelected(null);
}
$('scclose').addEventListener('click', closeSpotCard);
// tapping the already-selected pill again closes the card instead of re-opening it
function tapBlock(b) {
  if (!$('spotcard').hidden && cardBlock && cardBlock.id === b.id) { closeSpotCard(); return; }
  showSpotCard(b);
}
// tapping anywhere else on the map (i.e. not a pill) closes the card too
document.addEventListener('click', (e) => {
  if ($('spotcard').hidden) return;
  if (e.target.closest('#spotcard') || e.target.closest('.maplibregl-marker')) return;
  closeSpotCard();
}, true);

// same outside-tap dismissal for the menu drawer + its sub-panels: tapping the map,
// a pill (which also closeMenu()s itself via showSpotCard), or anything else outside
// the drawer family closes it. Tapping the menu button itself is left to its own
// click handler so it can still toggle back open.
document.addEventListener('click', (e) => {
  const open = $('menupanel').classList.contains('open') || $('changelog').classList.contains('open')
    || $('privacy').classList.contains('open');
  if (!open) return;
  if (e.target.closest('#menupanel') || e.target.closest('#changelog') || e.target.closest('#privacy')
    || e.target.closest('#menubtn')) return;
  closeMenu();
}, true);

// tap the summary line → slide the full report list in; back returns to the card
$('scflag').addEventListener('click', () => { if (!$('scflag').hidden) openReportList(); });
$('rlBack').addEventListener('click', closeReportList);

// ---- report flow -------------------------------------------------------------
let reportBlock = null, reportReason = null;

function resetPhotoLabel() {
  $('rsPhotoInner').innerHTML = CAMERA_SVG +
    '<span class="rs-phead">Add a photo of the sign</span>' +
    '<span class="rs-psub">Proof helps others trust the report — optional</span>';
}
function buildReasons(isFree) {
  const list = isFree ? REASONS_FREE : REASONS_PAID;
  $('rsReasons').innerHTML = list.map((o) =>
    `<button type="button" class="rs-reason" data-code="${o.code}"><span>${o.label}</span><span class="rs-radio"></span></button>`
  ).join('');
}
function openReport(b) {
  closeReportList();
  reportBlock = b; reportReason = null;
  buildReasons(!!b.isFree);
  $('rsOther').hidden = true; $('rsOther').value = '';
  $('rsPhoto').value = ''; resetPhotoLabel();
  $('rsSub').textContent = (b._label || (b.isFree ? 'Free spot' : 'Metered spot'));
  $('rsSubmit').disabled = false; $('rsSubmit').textContent = 'Submit report';
  $('spotcard').hidden = true;
  $('reportsheet').hidden = false;
}
function closeReport(reopen) {
  $('reportsheet').hidden = true;
  const b = reportBlock; reportBlock = null;
  if (reopen && b) showSpotCard(b);
}
$('screport').addEventListener('click', () => { if (cardBlock) openReport(cardBlock); });
$('scmaps').addEventListener('click', () => track('opened_in_maps', { city: activeCity, from: 'spotcard' }));

// share the spot as a Google Maps pin — native share sheet, clipboard fallback
function shareSpot(b) {
  const label = b._label || blockLabel(b) || 'this parking spot';
  const url = `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lon}`;
  if (navigator.share) { navigator.share({ title: 'Park Daddy', text: `Parking at ${label}`, url }).catch(() => {}); return; }
  if (navigator.clipboard) { navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard.'), () => window.open(url, '_blank', 'noopener')); return; }
  window.open(url, '_blank', 'noopener');
}
$('scshare').addEventListener('click', () => { if (cardBlock) shareSpot(cardBlock); });
$('rsClose').addEventListener('click', () => closeReport(true));
$('rsReasons').addEventListener('click', (e) => {
  const btn = e.target.closest('.rs-reason');
  if (!btn) return;
  reportReason = btn.dataset.code;
  $('rsReasons').querySelectorAll('.rs-reason').forEach((x) => x.classList.toggle('sel', x === btn));
  const other = reportReason === 'other';
  $('rsOther').hidden = !other;
  if (other) $('rsOther').focus();
});
$('rsPhoto').addEventListener('change', () => {
  const f = $('rsPhoto').files[0];
  if (!f) { resetPhotoLabel(); return; }
  const url = URL.createObjectURL(f);
  $('rsPhotoInner').innerHTML = `<img class="rs-thumb" src="${url}" alt="chosen photo"><span class="rs-psub">Tap to change photo</span>`;
});
$('rsSubmit').addEventListener('click', async () => {
  if (!reportBlock) return;
  if (!reportReason) { toast('Pick what’s wrong first.'); return; }
  const detail = reportReason === 'other' ? $('rsOther').value.trim() : '';
  if (reportReason === 'other' && !detail) { toast('Add a short description.'); $('rsOther').focus(); return; }
  $('rsSubmit').disabled = true; $('rsSubmit').textContent = 'Sending…';
  try {
    await submitReport({ block: reportBlock, reason: reportReason, detail, photoFile: $('rsPhoto').files[0] || null });
    track('report_submitted', { city: activeCity, reason: reportReason, photo: !!$('rsPhoto').files[0] });
    const b = reportBlock;
    closeReport(false);
    toast('Thanks — report submitted. 💛');
    await loadFlags();          // pull the new report back so the badge/hide + card update
    showSpotCard(b);
  } catch (e) {
    console.warn('[reports] submit failed', e);
    toast('Could not submit — please try again.');
    $('rsSubmit').disabled = false; $('rsSubmit').textContent = 'Submit report';
  }
});

// ---- city lists, rendered from the registry -------------------------------------
// The first-run picker and the menu's "Available cities" grid were both hand-written
// markup listing the same cities. San Jose shipped in the registry, the menu, the page
// title and the coverage sentence — but not the picker, so for nine days anyone opening
// the app in San Jose had to choose a city they weren't in. Both now render from CITIES,
// which is the only thing that actually stops that recurring.
const CHEV_WC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const PIN_WC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
function renderCityLists() {
  const cities = Object.entries(CITIES);
  const isNew = newCities();
  // The menu lists everything we cover — that's a coverage claim, and `picker: false`
  // doesn't make a city any less covered. Only the first-run picker filters.
  $('mnCities').innerHTML = cities
    .map(([, c]) => `<div class="mn-city">${c.flag} ${c.name}</div>`).join('');
  $('wcRows').innerHTML = cities.filter(([, c]) => c.picker !== false).map(([key, c]) => {
    const cc = c.geo.cc;
    const badges = (isNew.has(key) ? '<span class="wc-new">New</span>' : '')
      + (c.live ? '<span class="wc-live"><i></i>Live spots</span>' : '');
    return `<button class="wc-row" type="button" data-city="${key}">` +
      `<span class="wc-flag"><img src="https://flagcdn.com/w80/${cc}.png" srcset="https://flagcdn.com/w160/${cc}.png 2x" alt="" loading="lazy"></span>` +
      `<span><span class="wc-nmrow"><span class="wc-nm">${c.name}</span>${badges}</span><span class="wc-rg">${c.region}</span></span>` +
      `<span class="wc-chev">${CHEV_WC}</span></button>`;
  }).join('') +
    // The way out for everyone else. The request-a-city flow already existed but only
    // opened after a search missed, i.e. after you'd been made to pick a city you're not
    // in — the one moment someone most wants to say "I'm in Portland" was the one moment
    // they couldn't.
    `<button class="wc-row wc-ask" type="button" id="wcAsk">` +
    `<span class="wc-flag wc-askic">${PIN_WC}</span>` +
    `<span><span class="wc-nmrow"><span class="wc-nm">My city isn't here</span></span>` +
    `<span class="wc-rg">Tell me where to go next</span></span>` +
    `<span class="wc-chev">${CHEV_WC}</span></button>`;
}
renderCityLists();

// ---- sheet scrim ---------------------------------------------------------------
// Every sheet that wants the map dimmed behind it, minus the price one: on the spot card
// you're reading the card against the street it describes, so the map stays bright. The
// report list is on the list — it now replaces the spot card rather than covering it, so
// there's no price left on screen to read against. Driven by a MutationObserver rather
// than a call at each open/close — those sites are spread across five features, and the
// last three times a sheet was added the pattern was copied and one exit was missed.
const SCRIM_SHEETS = ['reportsheet', 'fbsheet', 'nasheet'];               // hidden attribute
const SCRIM_PANELS = ['menupanel', 'changelog', 'privacy', 'reportlist']; // .open class
function syncScrim() {
  const on = SCRIM_SHEETS.some((id) => !$(id).hidden)
          || SCRIM_PANELS.some((id) => $(id).classList.contains('open'));
  $('scrim').classList.toggle('on', on);
}
{
  const obs = new MutationObserver(syncScrim);
  for (const id of [...SCRIM_SHEETS, ...SCRIM_PANELS]) {
    obs.observe($(id), { attributes: true, attributeFilter: ['hidden', 'class'] });
  }
  syncScrim();
}
// Tapping the dim area dismisses, the way tapping the map already dismisses the spot card
// and the menu. It's a plain close, not the header's back arrow — reaching past a sheet to
// the map behind it means "I'm done", not "take me up a level".
$('scrim').addEventListener('click', () => {
  if (!$('fbsheet').hidden) { closeFbSheet(); return; }
  if (!$('nasheet').hidden) { closeNaSheet(); return; }
  if (!$('reportsheet').hidden) { closeReport(true); return; }
  // closeSpotCard nulls cardBlock first, so the list closes without the card popping back
  if ($('reportlist').classList.contains('open')) { closeSpotCard(); return; }
  closeMenu();
});

// ---- menu drawer: feedback + changelog ---------------------------------------
// Every destination SWAPS with the drawer rather than stacking over it: the menu drops
// away as the destination rises in its place, and back reverses the pair. That's how
// Feedback has always behaved (it's a .spotcard, so it couldn't stack); What's new and
// Privacy now match it instead of sliding in from the right over a menu still sitting
// there. Tapping the map still closes the whole family outright — see the scrim and the
// outside-tap handler; only the header's back arrow puts the menu back.
function openMenu() { closeSpotCard(); $('menupanel').classList.add('open'); }
function openDrilldown(id) { $('menupanel').classList.remove('open'); $(id).classList.add('open'); }
function closeDrilldown(id) { $(id).classList.remove('open'); openMenu(); }
function closeMenu() {
  $('menupanel').classList.remove('open');
  $('changelog').classList.remove('open');
  $('privacy').classList.remove('open');
}
$('menubtn').addEventListener('click', () => {
  if ($('menupanel').classList.contains('open')) closeMenu(); else openMenu();
});
$('mnClose').addEventListener('click', closeMenu);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('fbsheet').hidden) { fbBack(); return; }
  if (!$('nasheet').hidden) { closeNaSheet(); return; }
  if ($('privacy').classList.contains('open')) { closeDrilldown('privacy'); return; }
  if ($('changelog').classList.contains('open')) { closeDrilldown('changelog'); return; }
  if ($('menupanel').classList.contains('open')) closeMenu();
});

$('mnChangelog').addEventListener('click', () => {
  $('clList').innerHTML = CHANGELOG.map((rel) =>
    `<div class="cl-rel"><div class="cl-date">${rel.date}</div><ul class="cl-list">` +
    rel.items.map((t) => `<li><span>${t}</span></li>`).join('') +
    `</ul></div>`
  ).join('');
  openDrilldown('changelog');
});
$('clBack').addEventListener('click', () => closeDrilldown('changelog'));

$('mnPrivacy').addEventListener('click', () => openDrilldown('privacy'));
$('pvBack').addEventListener('click', () => closeDrilldown('privacy'));

// real email check — HTML5 type=email's built-in constraint accepts things like
// "a@b" (no dot required), so validate it ourselves: local@domain.tld, no spaces.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// inline red-text errors (not toasts) under a field — same pattern for both the
// message textarea and the email input, keyed by field/error element ids.
function setFieldError(fieldId, errId, msg) {
  const field = $(fieldId), err = $(errId);
  if (!msg) { err.hidden = true; err.textContent = ''; field.classList.remove('err'); return; }
  err.hidden = false; err.textContent = msg; field.classList.add('err');
}
const setFbTextError = (msg) => setFieldError('fbText', 'fbTextErr', msg);
const setFbError = (msg) => setFieldError('fbContact', 'fbErr', msg);
// Send stays disabled until both fields have something in them — full validation
// (message length, email shape) still runs on submit and surfaces as the errors above.
function updateFbSubmit() {
  $('fbSubmit').disabled = !$('fbText').value.trim() || !$('fbContact').value.trim();
}
$('fbText').addEventListener('input', () => { setFbTextError(null); updateFbSubmit(); });
$('fbContact').addEventListener('input', () => { setFbError(null); updateFbSubmit(); });

// The keyboard shrinks visualViewport but leaves the layout viewport where it was, so a
// bottom-anchored sheet sits behind it. Mirror the keyboard height into --kb while the
// feedback sheet is open (CSS lifts the sheet by it); zero it out when it closes.
const vvp = window.visualViewport;
function syncKeyboardInset() {
  if (!vvp) return;
  const kb = $('fbsheet').hidden ? 0 : Math.max(0, innerHeight - vvp.height - vvp.offsetTop);
  document.documentElement.style.setProperty('--kb', kb + 'px');
}
if (vvp) {
  vvp.addEventListener('resize', syncKeyboardInset);
  vvp.addEventListener('scroll', syncKeyboardInset);
}
function closeFbSheet() {
  $('fbsheet').hidden = true;
  fbBackTo = null;
  syncKeyboardInset();
  const done = fbOnClose; fbOnClose = null;
  if (done) done();
}
// One way in, three callers: the menu, "Request city", and the first-run picker's "my city
// isn't here". Each used to repeat the same five lines of reset, and the prefilled ones
// only differ in what's already typed and which field still needs the user.
// `backTo` is what the header chevron returns to — null when there's nothing behind it.
// `onClose` runs once on the way out, whichever exit they take (back, scrim, Esc, send).
function openFeedback({ text = '', backTo = null, focus = 'text', onClose = null } = {}) {
  fbOnClose = onClose;
  $('fbText').value = text;
  $('fbContact').value = '';
  setFbTextError(null); setFbError(null);
  $('fbSubmit').textContent = 'Send feedback';
  updateFbSubmit();
  fbBackTo = backTo;
  $('fbsheet').hidden = false;
  $(focus === 'contact' ? 'fbContact' : 'fbText').focus();
}
// The feedback sheet is always a drill-down, so its header chevron goes back rather than
// just dismissing — whoever opened it leaves behind the way to return (the menu, or the
// no-coverage sheet with its place intact). Falls back to a plain close if nothing did.
let fbBackTo = null;
// Deferred work owed to whoever opened the sheet — currently the picker's "my city isn't
// here", which owes the boot gate. Cleared as it fires, so it can never run twice.
let fbOnClose = null;
function fbBack() {
  const back = fbBackTo;
  closeFbSheet();
  if (back) back();
}

// ---- "not available there yet" -----------------------------------------------
// A searched place that's real but outside our five metros. Naming it matters: "not
// available in Portland yet" tells you the app works and just doesn't reach you, where
// a bare "couldn't find that" reads as a broken search box.
let naPlace = null;
// Name a place the way a person would: the place, then the biggest thing that pins it down.
// Take the two most specific non-duplicate parts of city -> state -> country:
//
//   Vancouver / Washington / United States  -> "Vancouver, Washington"   (state disambiguates)
//   Lisbon    / --         / Portugal       -> "Lisbon, Portugal"        (no state to use)
//   --        / Tokyo      / Japan          -> "Tokyo, Japan"            (city-states have no city)
//   Singapore / Singapore  / Singapore      -> "Singapore"               (all three collapse)
//
// The duplicate check is what keeps "Lisbon, Lisbon" and "Singapore, Singapore" out; it
// normalizes case and accents, and Accept-Language: en on both lookups means the fields
// come back in one language so the comparison can actually match.
//
// Returns null when Nominatim gives us nothing usable (a lake, a peak, a bare postcode);
// callers choose their own fallback wording rather than inheriting a vague phrase.
const normPlace = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
function displayPlace(p) {
  if (!p) return null;
  const parts = [];
  const add = (v) => { if (v && !parts.some((x) => normPlace(x) === normPlace(v))) parts.push(v); };
  add(p.city);
  add(p.state);
  if (parts.length < 2) add(p.country);   // country only earns its slot when the state didn't
  return parts.slice(0, 2).join(', ') || null;
}
// The request message keeps the country too — "Please add Vancouver, Washington" is
// ambiguous in an inbox in a way the on-screen heading never is, because there the map
// behind it already said which continent you were looking at. Same dedupe, no 2-part cap.
function requestPlace(p) {
  if (!p) return null;
  const parts = [];
  const add = (v) => { if (v && !parts.some((x) => normPlace(x) === normPlace(v))) parts.push(v); };
  add(p.city); add(p.state); add(p.country);
  return parts.join(', ') || null;
}
// "Vancouver, Seattle, San Francisco, San Jose and Kirkland" — built from the registry so
// adding a city updates this sentence for free. It's the fourth place the list appears
// (menu, page title, coverage sheet, here); the other three are static markup, this one
// doesn't have to be.
function coverageSentence() {
  const names = Object.values(CITIES).map((c) => c.name);
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
// Rendering is split from the search that triggered it so the feedback sheet's back arrow
// can put this sheet back exactly as it was without logging a second search that never
// happened.
function openNaSheet(p) {
  naPlace = p;
  // The heading carries the place; the body carries the coverage. Neither repeats the
  // other, which is what let the third type tier go.
  // Heading takes the bare city so it stays one line on a phone; the full "Portland,
  // Oregon, United States" form is saved for the request message, where the
  // disambiguation actually matters because it lands in an inbox out of context.
  const city = p.city || p.state || p.country;
  $('naTitle').textContent = city ? `No data for ${city} yet.` : 'No data for that area yet.';
  $('naSub').textContent = `Park Daddy currently works in ${coverageSentence()}.`;
  closeSpotCard();
  $('nasheet').hidden = false;
}
function showNoCoverage(p) {
  openNaSheet(p);
  // Coarse place only — town, state/province, country. Never the address that was typed.
  // This is the demand signal for what to build next (see the privacy policy).
  track('search_out_of_coverage', { city: p.city || null, state: p.state || null, country: p.country || null });
}
function closeNaSheet() { $('nasheet').hidden = true; naPlace = null; syncKeyboardInset(); }
$('naClose').addEventListener('click', closeNaSheet);
// Hand off to the existing feedback pipe rather than build a second one — prefilled so
// the ask is one tap plus an email, and still fully editable before it sends.
$('naRequest').addEventListener('click', () => {
  const p = naPlace;
  const label = requestPlace(p) || 'my city';
  track('city_requested', { city: p?.city || null, state: p?.state || null, country: p?.country || null });
  closeNaSheet();
  // Short and warm — it's a request from one person to another, and it lands in the same
  // inbox as free-form feedback. Still editable before it sends. Focus goes to the email
  // because the message is already written for them; back returns to the sheet that sent
  // us here, with the same place still named on it.
  openFeedback({ text: `Please add ${label} 🙏`, backTo: () => openNaSheet(p), focus: 'contact' });
});

$('mnFeedback').addEventListener('click', () => {
  closeMenu();
  openFeedback({ backTo: openMenu });
});
$('fbBack').addEventListener('click', fbBack);
$('fbSubmit').addEventListener('click', async () => {
  const message = $('fbText').value.trim();
  const contact = $('fbContact').value.trim();
  if (!message) { setFbTextError('Oops, looks like you forgot the message!'); $('fbText').focus(); return; }
  setFbTextError(null);
  if (!contact) { setFbError('Add your email so I can reply.'); $('fbContact').focus(); return; }
  if (!EMAIL_RE.test(contact)) { setFbError('That email doesn’t look right — check it and try again.'); $('fbContact').focus(); return; }
  setFbError(null);
  $('fbSubmit').disabled = true; $('fbSubmit').textContent = 'Sending…';
  try {
    await submitFeedback({ message, contact });
    track('feedback_submitted', {});
    closeFbSheet();
    toast('Thanks — feedback sent. 💛');
  } catch (e) {
    console.warn('[feedback] submit failed', e);
    toast(e.status === 404
      ? 'Feedback isn’t hooked up yet — bug Char about it.'
      : 'Could not send — please try again.');
    $('fbSubmit').disabled = false; $('fbSubmit').textContent = 'Send feedback';
  }
});

function updateRecenter() {
  // The recenter fab only surfaces during turn-by-turn nav (the search bar's
  // "go to my location" handles it in plain drive mode). Compass never morphs.
  const show = driving.isActive() ? !driving.isFollowing() : false;
  $('recenter').classList.toggle('show', show);
}

function initLiveLabels() {
  // `blocks` is already populated by loadCity (and grows as more cities load).
  labelLayer = createLabelLayer(map, blocks, { nowMins, isWeekend, dow: dowNow, onTap: tapBlock, flagState });
  labelLayer.refresh();
  // Lazy-load a city's data the moment the map center enters its coverage box.
  map.on('moveend', () => {
    const ctr = map.getCenter();
    const k = cityAt(ctr.lat, ctr.lng);
    if (k && !loadedCities.has(k)) loadCity(k);
    if (k) activeCity = k;
  });
  // real pills are on the map now — fade the boot skeleton out and drop it
  const skel = $('skel');
  if (skel) { skel.classList.add('hide'); setTimeout(() => skel.remove(), 600); }
  loadFlags();   // fetch crowd reports, then refresh pills to show warnings / hide 3+ flagged
  nav = createNav({ map });

  driving = createDriving({
    map,
    bearing: desiredBearing,
    // Passive follow only chases fixes inside a covered city — same guard the boot recenter uses —
    // so an out-of-coverage or bogus fix can't strand the camera on a blank, dataless area.
    coverage: (pos) => cityAt(pos.lat, pos.lon) != null,
    // During turn-by-turn nav, draw the car snapped onto the route so GPS scatter can't park the
    // puck on a building. In plain drive mode there's no route to snap to, so the raw fix shows.
    resolveDisplay: (pos) => (nav && nav.isActive() ? nav.snap(pos) : null),
    onFix(pos) {
      labelLayer.setFocus(pos);
      if (nav.isActive()) onNavFix(pos);
      // per-fix camera (center + heading-up bearing) is eased inside driving.js

      // auto-dismiss the card only once you've driven PAST its block —
      // never while approaching a spot you tapped up ahead
      if (cardBlock) {
        const d = distMeters(pos.lat, pos.lon, cardBlock.lat, cardBlock.lon);
        if (d > 150 && cardOpenDist != null && d > cardOpenDist + 40) {
          closeSpotCard();   // clears the dashed spot line + pill highlight too, not just the card
        }
        if (cardOpenDist != null) cardOpenDist = Math.min(cardOpenDist, d);
      }
    },
    onActiveChange(state) {
      document.body.classList.toggle('driving', !!state);
      if (state === 'nolock') toast('Keep your screen on — this browser can\'t hold a wake lock.');
      applyOrientation();               // Drive mode on → heading-up + compass; off → un-rotate
      updateRecenter();
      labelLayer.refresh();
    },
    onFollowChange: () => updateRecenter(),
  });

  $('drivebtn').addEventListener('click', () => {
    track('drive_mode_toggled', { city: activeCity, on: !driving.isActive() });
    if (driving.isActive()) {
      endNav(false);
      driving.stop();
      // return to the exact screen we left — restore map view + any open spot card
      if (preDrive) {
        map.jumpTo({ center: preDrive.center, zoom: preDrive.zoom, bearing: 0 });
        if (preDrive.block) showSpotCard(preDrive.block);
        preDrive = null;
      }
    } else {
      // snapshot, then clear the card so live rates fill the screen while driving
      preDrive = { center: map.getCenter(), zoom: map.getZoom(), block: cardBlock };
      $('spotcard').hidden = true; cardBlock = null; clearSpotLine();
      if (labelLayer) labelLayer.setSelected(null);
      orientMode = 'heading';   // each drive session starts heading-up (POV)
      driving.start();
    }
  });
  // First tap on Start shows a one-time disclaimer (no live traffic/closures);
  // after they choose "Use Start anyway" we remember it and go straight through.
  const NAVWARN_KEY = 'pd_navwarn_seen';
  let warnBlock = null;
  const closeNavWarn = () => $('navwarn').classList.remove('show');
  $('scstart').addEventListener('click', () => {
    if (!cardBlock) return;
    let seen = false;
    try { seen = !!localStorage.getItem(NAVWARN_KEY); } catch {}
    if (seen) { startNav(cardBlock); return; }
    warnBlock = cardBlock;
    $('navwarn').classList.add('show');
  });
  $('nwStart').addEventListener('click', () => {
    // navigation_started now fires inside startNav() itself, so every future tap is counted
    // too — not just the one that happens to trigger this one-time warning dialog.
    try { localStorage.setItem(NAVWARN_KEY, '1'); } catch {}
    closeNavWarn();
    if (warnBlock) startNav(warnBlock);
  });
  $('nwMaps').addEventListener('click', () => {
    track('opened_in_maps', { city: activeCity, from: 'navwarn' });
    closeNavWarn();
    if (warnBlock) window.open(navUrl(warnBlock), '_blank', 'noopener');
  });
  $('nwClose').addEventListener('click', closeNavWarn);
  $('navwarn').addEventListener('click', (e) => { if (e.target === $('navwarn')) closeNavWarn(); });
  $('navend').addEventListener('click', () => endNav(false));
  $('compass').addEventListener('click', () => {
    // In a driving/nav session the compass toggles heading-up ⇄ north-up; in plain browse it
    // snaps the freely-rotated map back to north (like Google Maps).
    const from = map.getBearing();
    if (driving && driving.isActive()) orientMode = orientMode === 'heading' ? 'north' : 'heading';
    applyOrientation();
    springCompass(from);
  });
  $('recenter').addEventListener('click', async () => {
    if (driving.isActive()) { driving.setFollow(true); return; }
    const pos = await getPosition();
    if (pos) map.easeTo({ center: [pos.lon, pos.lat], zoom: 16, duration: reduceMotion() ? 0 : 600 });
    else toast('Could not get your location.');
  });
  updateRecenter();
  window.__pk = { map, layer: labelLayer, driving, blocks, showSpotCard, loadFlags, flagFor };  // debug handle
  // Drive mode is the default surface: open focused on the user (passive, low-power).
  // But starting it fires getCurrentPosition/watchPosition, i.e. the permission prompt — so it
  // waits on the same boot gate as the recenter, or the prompt lands *over* the welcome picker.
  if (params.get('sim')) driving.start();
  else bootUISettled.then(() => driving.start({ passive: true }));
}

// ---- first-visit city picker -----------------------------------------------
// Shown once per browser. Tapping a city flies there and loads its feeds (goToCity), which also
// suppresses the boot geolocation recenter. Tapping the scrim or Esc dismisses without choosing,
// leaving whatever city geolocation picked. Deep links (?lat/?lon or ?dest) skip it entirely.
(function initWelcome() {
  const el = document.getElementById('welcome');
  // Every early return must still open the boot gate, or the location prompt —
  // which now waits on it — would never fire at all.
  if (!el) { openBootGate(); return; }
  const WELCOME_KEY = 'pd_welcome_seen';
  const force = params.get('welcome') === '1';   // local override to preview the picker after it's been seen
  if (!force && (store.get(WELCOME_KEY) || params.get('dest') || params.get('lat'))) {
    splashCleared().then(openBootGate);          // no picker: prompt once the splash clears
    return;
  }

  // Hold the picker until the boot splash has driven off, then let the map read
  // for a beat before the sheet rises. Revealing it at parse time (as this used
  // to) meant the sheet was already fully up behind the splash, so its wcRise
  // entrance was never actually seen.
  const BEAT = 550;   // hold on the bare map before the sheet enters
  splashCleared().then(() => setTimeout(() => el.classList.add('show'), BEAT));
  // Answering the picker — by tapping a city, the scrim, or Esc — is what releases
  // the location prompt.
  const dismiss = () => { el.classList.remove('show'); store.set(WELCOME_KEY, '1'); openBootGate(); };
  // [data-city] only — the "my city isn't here" row is a .wc-row too, and without the
  // attribute filter it would fall through to goToCity(null).
  $('wcAsk').addEventListener('click', () => {
    track('city_requested', { city: null, state: null, country: null, from: 'welcome' });
    // Answers the picker, but does NOT open the boot gate yet: the location prompt is a
    // native dialog and would land straight on top of the form they're about to type in —
    // the same stacking the gate exists to prevent. It opens when the sheet closes, which
    // every exit does, so the prompt is deferred rather than lost.
    el.classList.remove('show');
    store.set(WELCOME_KEY, '1');
    openFeedback({ text: 'Please add ', onClose: openBootGate });   // they finish the sentence
  });
  el.querySelectorAll('.wc-row[data-city]').forEach((row) => {
    row.addEventListener('click', () => { dismiss(); goToCity(row.getAttribute('data-city')); });
  });
  el.addEventListener('click', (e) => { if (e.target === el) dismiss(); });
  window.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape' && el.classList.contains('show')) { dismiss(); window.removeEventListener('keydown', onEsc); }
  });
})();
