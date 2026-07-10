import { rankMeters, rateNow, limitNow, bandRateNow, distMeters, ENF_START, MID, ENF_END } from './rank.js?v=14';
import { buildBlocks, buildSeattleBlocks, buildSeattleFreeBlocks, createLabelLayer, towSoon, fmtLimit, bucket } from './labels.js?v=22';
import { CITIES, cityAt, DEFAULT_CITY } from './cities.js?v=3';
import { createDriving, SIM_START } from './driving.js?v=23';
import { fetchRoute, createNav, fmtDist } from './nav.js?v=13';
import { fetchFlags, submitReport, rptKey, FLAG_MIN, HIDE_MIN } from './reports.js?v=1';

const $ = (id) => document.getElementById(id);
const TOPN = 5;
let meters = [];
const filters = { free: true, paid: true };
let map, tileLayer, markers = [], destMarker, lastLoc = null, cachedPos = null;

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
// Dark mode uses a label-free base + a separate labels overlay we brighten via CSS,
// so street names read clearly against the black canvas (plain dark_all labels are too dim).
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
  darkLabels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
};
const LABEL_BRIGHTNESS = 1.85; // dark-mode street-label lift; tune 1.6–2.0 by eye
let darkLabelTiles; // CARTO street-name overlay for dark mode (distinct from the price-pill labelLayer)
map = L.map('map', { zoomControl: false }).setView([49.2606, -123.114], 13);
function setTiles() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const url = dark ? TILES.dark : TILES.light;
  // Swap the URL in place rather than remove/re-add — re-adding a layer nudges the map view.
  if (tileLayer) { tileLayer.setUrl(url); }
  else {
    tileLayer = L.tileLayer(url, {
      maxZoom: 20, attribution: '© OpenStreetMap © CARTO',
    }).addTo(map);
  }
  // Brightened street-name tiles ride on top in dark mode only; removed entirely in light mode.
  if (dark) {
    if (!darkLabelTiles) {
      darkLabelTiles = L.tileLayer(TILES.darkLabels, { maxZoom: 20, zIndex: 5 }).addTo(map);
      darkLabelTiles.getContainer().style.filter = `brightness(${LABEL_BRIGHTNESS})`;
    }
  } else if (darkLabelTiles) {
    map.removeLayer(darkLabelTiles);
    darkLabelTiles = null;
  }
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
applyTheme(localStorage.getItem(THEME_KEY) || (darkMedia.matches ? 'dark' : 'light'));
darkMedia.addEventListener('change', () => {
  if (!localStorage.getItem(THEME_KEY)) applyTheme(darkMedia.matches ? 'dark' : 'light');
});
document.getElementById('themetoggle')?.addEventListener('click', (e) => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const swap = () => { localStorage.setItem(THEME_KEY, next); applyTheme(next); };

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
const loadedCities = new Set();
function pushBlocks(arr) { for (const b of arr) blocks.push(b); }

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
    });
    if (!labelLayer) initLiveLabels();          // first city: stand up the whole layer
    else labelLayer.refresh();                  // later cities: just repaint
  } catch { loadedCities.delete(key); setStatus('Failed to load parking data.'); }
}

// Pick the opening city from geolocation (fallback: default), center there, load it.
(async () => {
  let key = DEFAULT_CITY, center = null;
  if (params.get('lat') && params.get('lon')) {
    center = { lat: +params.get('lat'), lon: +params.get('lon') };
    key = cityAt(center.lat, center.lon) || DEFAULT_CITY;
  } else {
    const pos = await getPosition().catch(() => null);
    const k = pos && cityAt(pos.lat, pos.lon);
    if (k) { key = k; center = pos; }
  }
  activeCity = key;
  const c = CITIES[key];
  map.setView(center ? [center.lat, center.lon] : c.center, center ? 16 : c.zoom, { animate: false });
  await loadCity(key);
  if (params.get('lat') && params.get('lon')) {
    run({ lat: +params.get('lat'), lon: +params.get('lon'), name: params.get('dest') || 'Dropped pin' }, true);
  } else if (params.get('dest')) {
    run(null, true);
  }
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
function clearMap() { markers.forEach((m) => map.removeLayer(m)); markers = []; }

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
  const hasPhoto = !!r.photo_url;
  const thumb = hasPhoto && r.photo_url !== '#local'
    ? `<a class="rp-thumb" href="${esc(r.photo_url)}" target="_blank" rel="noopener"><img src="${esc(r.photo_url)}" alt="sign photo"></a>`
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
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function loadRecents() { try { return JSON.parse(localStorage.getItem(REC_KEY)) || []; } catch { return []; } }
function saveRecents(a) { try { localStorage.setItem(REC_KEY, JSON.stringify(a)); } catch {} }

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
  const rankable = CITIES[activeCity] && CITIES[activeCity].style === 'points' && meters.length;
  const ranked = rankable ? rankMeters(meters, { lat: loc.lat, lon: loc.lon, arrival, duration, maxWalkMin, sort: 'cheap' }) : [];
  current = ranked.slice(0, 40);   // kept only to frame the map around nearby spots

  if (labelLayer) labelLayer.setSelected(null);
  clearSpotLine();
  if (destMarker) map.removeLayer(destMarker);
  // dedicated pane above the price pills (mdots 610, pills 620) so the destination
  // pin is never hidden behind a pill — a per-marker zIndexOffset can't cross panes.
  if (!map.getPane('dest')) map.createPane('dest').style.zIndex = 630;
  destMarker = L.marker([loc.lat, loc.lon], {
    // indigo teardrop — a distinct SHAPE so no price-pill color can camouflage it
    pane: 'dest',
    icon: L.divIcon({ className: '', html: '<div class="destpinwrap"><svg class="destpin" width="34" height="34" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div>', iconSize: [34, 34], iconAnchor: [17, 32] }),
  }).addTo(map);

  frameMap(loc, current);
}

// center on destination, keep the 3 closest spots in view (symmetric so dest stays centred)
function frameMap(loc, list) {
  const near = list.slice(0, 3);
  let dLat = 0.0016, dLon = 0.0022;
  for (const r of near) { dLat = Math.max(dLat, Math.abs(r.lat - loc.lat)); dLon = Math.max(dLon, Math.abs(r.lon - loc.lon)); }
  const bounds = [[loc.lat - dLat, loc.lon - dLon], [loc.lat + dLat, loc.lon + dLon]];
  const opts = { paddingTopLeft: [40, 120], paddingBottomRight: [40, 40], maxZoom: 17 };
  // Ease into the destination instead of snapping; pills then drop in on moveend for a
  // clean arrival. Reduced-motion users get the old instant framing.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) map.fitBounds(bounds, { ...opts, animate: false });
  else map.flyToBounds(bounds, { ...opts, duration: 0.9 });
}

// ---- misc controls ----------------------------------------------------------
$('here').addEventListener('click', async () => {
  // "Go to my location": re-arm follow so drive mode snaps back onto you.
  if (driving?.isActive() && driving.lastPos()) { driving.setFollow(true); return; }
  const pos = await getPosition();
  if (!pos) { toast('Could not get your location.'); return; }
  driving?.setFollow(true);              // arm follow for incoming fixes
  map.setView([pos.lat, pos.lon], 16);   // immediate center on a one-shot fix
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
  if (!filters.paid && !localStorage.getItem('freeWarnSeen')) {
    toast('Free data is spotty and may be inaccurate — don’t rely on it. Confirm with posted signs.', 7000);
    localStorage.setItem('freeWarnSeen', '1');
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
let labelLayer = null, driving = null, cardBlock = null, cardOpenDist = null, preDrive = null, spotLine = null;

// straight connector from the tapped spot to the searched destination
function drawSpotLine(b) {
  clearSpotLine();
  if (!lastLoc) return;
  spotLine = L.polyline([[b.lat, b.lon], [lastLoc.lat, lastLoc.lon]], {
    color: '#1a1a1a', weight: 3, opacity: 0.7, dashArray: '1 9', lineCap: 'round', interactive: false,
  }).addTo(map);
}
function clearSpotLine() { if (spotLine) { map.removeLayer(spotLine); spotLine = null; } }
let nav = null, navTarget = null, blocks = [], lastRerouteT = 0;

// ---- map orientation: heading-up (POV) ⇄ north-up, toggled by the compass -----
let orientMode = 'heading';   // 'heading' = POV (default) | 'north'
let contRot = 0;              // continuous rotation (never wraps → shortest turn)
let navLayout = false;        // is the oversized follow wrapper (`follow` class) currently applied?
function setMapRot(deg) {
  contRot = deg;
  // --map-rot is a registered @property with a transition on <html>, so this assignment
  // animates — the map wrapper, price pills, and compass needle all read the same value
  // and swing in lockstep.
  document.documentElement.style.setProperty('--map-rot', deg.toFixed(1) + 'deg');
}
// Called on drive/nav start/end, each fix, and on compass toggle. Rotates the map to
// the current heading in POV mode; snaps back to north otherwise. Active whenever we're
// following the car — Drive mode or turn-by-turn — so it survives nav auto-ending on
// arrival (still driving → stays heading-up). The oversized `follow` wrapper spans the
// whole session (both orientations), so a compass toggle only changes the rotation angle
// — never the geometry — and the --map-rot transition animates it as a smooth swing.
// invalidateSize fires only when the wrapper actually resizes (entering/leaving the session).
function applyOrientation() {
  const active = document.body.classList.contains('nav') || document.body.classList.contains('driving');
  const headingUp = active && orientMode === 'heading';
  document.body.classList.toggle('follow', active);
  if (headingUp) {
    const hdg = (driving && driving.lastPos() && driving.lastPos().hdg) || 0;
    const delta = ((-hdg - contRot) % 360 + 540) % 360 - 180;   // shortest turn to -heading
    setMapRot(contRot + delta);
  } else {
    setMapRot(Math.round(contRot / 360) * 360);                 // nearest visual north
  }
  if (navLayout !== active) {
    navLayout = active;
    // Entering/leaving the session resizes the wrapper (viewport ⇄ 120vmax). Suppress the
    // --map-rot transition (on <html>) for just this switch so the map doesn't spin on
    // start/end, force layout, sync Leaflet to the new size, and re-center the car. A plain
    // compass toggle skips this block, so it keeps the smooth swing.
    const de = document.documentElement;
    de.style.transition = 'none';
    void de.offsetWidth;
    map.invalidateSize({ animate: false });
    if (driving && driving.isFollowing()) driving.recenter();   // snap onto the drawn marker
    void de.offsetWidth;
    de.style.transition = '';   // restore the stylesheet's transition for toggles
  }
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
  $('spotcard').hidden = true; cardBlock = null;
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
  applyOrientation();               // POV by default → rotate the map heading-up
  driving.setSimTrack(r.coords);
  if (!driving.isActive()) driving.start(); else driving.setFollow(true);
  driving.setNavMode(true);           // routing → high-accuracy GPS + wake lock
  onNavFix(from);
}

async function onNavFix(pos) {
  const p = nav.update(pos);
  if (!p || !navTarget) return;
  if (p.arrived || distMeters(pos.lat, pos.lon, navTarget.lat, navTarget.lon) < 25) { endNav(true); return; }
  applyOrientation();               // keep the map pointed heading-up as we move
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
  if (arrived) toast('You’ve arrived — pick a spot from the price pills.', 7000);
}

function toast(msg, ms = 5000) {
  const t = $('toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, ms);
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
function daySegments(b, wknd) {
  const rushes = b.rushes || [];
  const rateAt = (m) => (m < ENF_START || m >= ENF_END) ? 0 : (m < MID ? (b.rate1 || 0) : (b.rate2 || 0));
  const towAt = (m) => rushes.some((r) => m >= r[0] && m < r[1]);
  // cut the day at every window edge AND every tow-away boundary, then classify
  // each slice by its midpoint so rush hours carve "no parking" gaps out of the rates
  const bounds = new Set([0, ENF_START, MID, ENF_END, 1440]);
  for (const r of rushes) {
    if (r[0] > 0 && r[0] < 1440) bounds.add(r[0]);
    if (r[1] > 0 && r[1] < 1440) bounds.add(r[1]);
  }
  const pts = [...bounds].sort((x, y) => x - y);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i], to = pts[i + 1], mid = (from + to) / 2;
    const tow = towAt(mid);
    const rate = tow ? 0 : rateAt(mid);
    const limit = (!tow && rate > 0) ? limitNow(b.limits, mid, wknd) : null;   // only paid windows carry a limit
    const last = segs[segs.length - 1];
    if (last && last.tow === tow && last.rate === rate && last.limit === limit) last.to = to;
    else segs.push({ from, to, rate, tow, limit });
  }
  return segs;
}

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
  const segs = b.bands ? seattleDaySegments(b, dowNow()) : daySegments(b, isWeekend());
  el.innerHTML = segs.map((s) => {
    const active = mins >= s.from && mins < s.to;
    const free = !s.tow && s.rate === 0;
    const cost = s.tow ? 'No parking' : (free ? 'Free' : `${money(s.rate)}/hr`);
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
  // the full-day schedule table already shows every tow-away window; this row is
  // only an urgency nudge when one is about to start (the table can be scrolled past)
  const tow = towSoon(b, mins, 90);
  if (tow) {
    // compact range: drop :00 and the leading meridiem when both ends share it → "3–7pm"
    const short = (m) => {
      const h = Math.floor(m / 60) % 24, mm = m % 60;
      return { t: (h % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : ''), ap: h >= 12 ? 'pm' : 'am' };
    };
    const s = short(tow[0]), e = short(tow[1]);
    const range = (s.ap === e.ap ? s.t : s.t + s.ap) + '–' + e.t + e.ap;
    const soon = tow[0] - mins <= 90 ? ` starts in ${tow[0] - mins} min` : '';
    rows.push(`<span class="warn">${IC.alert} No parking ${range} · tow-away${soon}</span>`);
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
  if (e.target.closest('#spotcard') || e.target.closest('.leaflet-marker-icon')) return;
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
    onFix(pos) {
      labelLayer.setFocus(pos);
      if (nav.isActive()) onNavFix(pos);
      else applyOrientation();          // Drive mode: keep the map pointed heading-up

      // auto-dismiss the card only once you've driven PAST its block —
      // never while approaching a spot you tapped up ahead
      if (cardBlock) {
        const d = distMeters(pos.lat, pos.lon, cardBlock.lat, cardBlock.lon);
        if (d > 150 && cardOpenDist != null && d > cardOpenDist + 40) {
          $('spotcard').hidden = true; cardBlock = null;
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
        map.setView(preDrive.center, preDrive.zoom, { animate: false });
        if (preDrive.block) showSpotCard(preDrive.block);
        preDrive = null;
      }
    } else {
      // snapshot, then clear the card so live rates fill the screen while driving
      preDrive = { center: map.getCenter(), zoom: map.getZoom(), block: cardBlock };
      $('spotcard').hidden = true; cardBlock = null; clearSpotLine();
      if (labelLayer) labelLayer.setSelected(null);
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
    orientMode = orientMode === 'heading' ? 'north' : 'heading';
    applyOrientation();
  });
  $('recenter').addEventListener('click', async () => {
    if (driving.isActive()) { driving.setFollow(true); return; }
    const pos = await getPosition();
    if (pos) map.setView([pos.lat, pos.lon], 16);
    else toast('Could not get your location.');
  });
  updateRecenter();
  window.__pk = { map, layer: labelLayer, driving, blocks, showSpotCard, loadFlags, flagFor };  // debug handle
  // Drive mode is the default surface: open focused on the user (passive, low-power).
  if (params.get('sim')) driving.start();
  else driving.start({ passive: true });
}
