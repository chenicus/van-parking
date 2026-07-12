import { rankMeters, rateNow, limitNow, bandRateNow, distMeters, ENF_START, MID, ENF_END, prohibitionWindowsForDay, prohibitionNow } from './rank.js?v=15';
import { buildBlocks, buildSeattleBlocks, buildSeattleFreeBlocks, buildSFBlocks, createLabelLayer, fmtLimit, bucket } from './labels.js?v=28';
import { CITIES, cityAt, DEFAULT_CITY } from './cities.js?v=5';
import { createDriving, SIM_START } from './driving.js?v=26';
import { fetchRoute, createNav, fmtDist } from './nav.js?v=16';
import { fetchFlags, submitReport, rptKey, FLAG_MIN, HIDE_MIN } from './reports.js?v=1';

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
function clockMins() {
  if (mockT != null) return mockT;
  const d = new Date(); return d.getHours() * 60 + d.getMinutes();
}
// fixed assumed stay length (hours) — no longer user-set; used only to rank spots
// (rush-hour tow-away overlap) when a destination is searched
const trip = { mode: 'now', durH: 2, etaMins: null, setMins: null, setDate: null, userSet: false };
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
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
  const day = new Date().getDay(); return day === 0 || day === 6;
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
  return new Date().getDay();
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
const mapLoaded = new Promise((res) => map.on('load', () => { mapReady = true; installLayers(); res(); }));

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
applyTheme(store.get(THEME_KEY) || (darkMedia.matches ? 'dark' : 'light'));
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
const loadedCities = new Set();
function pushBlocks(arr) { for (const b of arr) blocks.push(b); }

// Fly to a city and load its feeds. Used by the first-visit picker (#welcome).
async function goToCity(key) {
  const c = CITIES[key];
  if (!c) return;
  cityChosen = true;
  activeCity = key;
  await mapLoaded;
  map.jumpTo({ center: [c.center[1], c.center[0]], zoom: c.zoom });
  await loadCity(key);
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
    });
    if (!labelLayer) initLiveLabels();          // first city: stand up the whole layer
    else labelLayer.refresh();                  // later cities: just repaint
  } catch { loadedCities.delete(key); setStatus('Failed to load parking data.'); }
}

// Open on a city immediately, then best-effort recenter on the user. We deliberately do NOT
// block the first paint on geolocation: the browser's permission prompt has no timeout until
// the user answers, so awaiting a fix can hang the boot skeleton forever if the prompt is
// ignored (common at a red light). Paint the default city first; if a fix lands within a few
// seconds and it's in a covered city, pan there.
(async () => {
  await mapLoaded;   // MapLibre isn't usable until 'load' — unlike Leaflet's synchronous map

  // Deep link with explicit coords: honor it exactly — no geolocation needed. Guard against a
  // malformed/truncated share link (?lat=abc): a NaN center makes MapLibre throw and, inside this
  // un-caught boot IIFE, would leave the skeleton up forever — so fall through to the default city.
  const plat = +params.get('lat'), plon = +params.get('lon');
  if (Number.isFinite(plat) && Number.isFinite(plon)) {
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
async function geocodeOne(q, biased) {
  const p = new URLSearchParams({ format: 'json', limit: '1', countrycodes: GEO_CCS, q });
  if (biased) {
    const [[s, w], [n, e]] = (CITIES[activeCity] || CITIES[DEFAULT_CITY]).bounds;
    p.set('viewbox', `${w},${s},${e},${n}`);   // soft bias toward the current city (bounded=0)
  }
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + p.toString(), { headers: { 'Accept-Language': 'en' } });
  // Nominatim is a free shared server; under load it returns 429/503. Flag those
  // as `busy` so run() can tell "server rate-limited us" from "place not found".
  if (!r.ok) { const e = new Error('geocode ' + r.status); e.busy = r.status === 429 || r.status === 503; throw e; }
  const j = await r.json();
  return j.length ? { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), name: j[0].display_name } : null;
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
function closeReportList() { $('reportlist').classList.remove('open'); }

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
  if (!loc) { setStatus('Could not find that place. Try an address or nearby landmark.'); return; }
  driving?.setFollow(false);   // searching = looking elsewhere; let the map rest on the destination
  lastLoc = loc;
  addRecent(loc, q);
  trip.userSet = false;   // a fresh destination re-arms the "arrive on arrival" default
  rankAndRender(loc);
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

function featToSuggest(f) {
  const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
  if (!c) return null;
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ');
  if (!name) return null;
  // secondary line: street (when the name isn't already it), then area/city/state — deduped
  const sub = [p.name && p.street ? p.street : null, p.district, p.city, p.state, p.postcode]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(', ');
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
  renderSuggest(feats.map(featToSuggest).filter(Boolean));
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
  // marker it renders above the GL dot/line layers and stays screen-upright on rotate; a high
  // z-index keeps it above the price pills. anchor:'bottom' pins the tip to the coordinate.
  const dEl = document.createElement('div');
  dEl.innerHTML = '<div class="destpinwrap"><svg class="destpin" width="34" height="34" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div>';
  dEl.style.zIndex = '3';
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
  return segs;
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

  const r = b.bands ? bandRateNow(b.bands, mins, dowNow()) : rateNow(b.rate1, b.rate2, mins);
  $('scprice').innerHTML = r.free ? 'Free right now' : `${money(r.rate)}<span class="sc-unit">/hr</span>`;
  $('scprice').classList.toggle('free', r.free);

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

// tap the summary line → slide the full report list in; back returns to the card
$('scflag').addEventListener('click', () => { if (!$('scflag').hidden) $('reportlist').classList.add('open'); });
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
    try { localStorage.setItem(NAVWARN_KEY, '1'); } catch {}
    closeNavWarn();
    if (warnBlock) startNav(warnBlock);
  });
  $('nwMaps').addEventListener('click', () => {
    closeNavWarn();
    if (warnBlock) window.open(navUrl(warnBlock), '_blank', 'noopener');
  });
  $('nwClose').addEventListener('click', closeNavWarn);
  $('navwarn').addEventListener('click', (e) => { if (e.target === $('navwarn')) closeNavWarn(); });
  $('navend').addEventListener('click', () => endNav(false));
  $('compass').addEventListener('click', () => {
    // In a driving/nav session the compass toggles heading-up ⇄ north-up; in plain browse it
    // snaps the freely-rotated map back to north (like Google Maps).
    if (driving && driving.isActive()) orientMode = orientMode === 'heading' ? 'north' : 'heading';
    applyOrientation();
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
  if (params.get('sim')) driving.start();
  else driving.start({ passive: true });
}

// ---- first-visit city picker -----------------------------------------------
// Shown once per browser. Tapping a city flies there and loads its feeds (goToCity), which also
// suppresses the boot geolocation recenter. Tapping the scrim or Esc dismisses without choosing,
// leaving whatever city geolocation picked. Deep links (?lat/?lon or ?dest) skip it entirely.
(function initWelcome() {
  const el = document.getElementById('welcome');
  if (!el) return;
  const WELCOME_KEY = 'pd_welcome_seen';
  if (store.get(WELCOME_KEY) || params.get('dest') || params.get('lat')) return;
  el.classList.add('show');
  const dismiss = () => { el.classList.remove('show'); store.set(WELCOME_KEY, '1'); };
  el.querySelectorAll('.wc-row').forEach((row) => {
    row.addEventListener('click', () => { dismiss(); goToCity(row.getAttribute('data-city')); });
  });
  el.addEventListener('click', (e) => { if (e.target === el) dismiss(); });
  window.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape' && el.classList.contains('show')) { dismiss(); window.removeEventListener('keydown', onEsc); }
  });
})();
