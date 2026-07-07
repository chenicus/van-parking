import { rankMeters, rateNow, limitNow, costFor, distMeters, ENF_START, MID, ENF_END } from './rank.js?v=13';
import { buildBlocks, createLabelLayer, towSoon, fmtRate, fmtLimit, bucket } from './labels.js?v=13';
import { createDriving, SIM_START } from './driving.js?v=13';
import { fetchRoute, createNav, fmtDist } from './nav.js?v=13';

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
// duration slider stops (hours); 99 = "All day" (spans the enforced 9am–10pm window)
const DUR_STOPS = [0.5, 1, 1.5, 2, 3, 4, 6, 99];
const durLabel = (h) => h >= 99 ? 'All day' : (h % 1 ? Math.round(h * 60) + 'm' : h + 'h');
const trip = { mode: 'now', durH: 2, etaMins: null, setMins: null, userSet: false };
function arrivalMins() {
  if (trip.mode === 'set' && trip.setMins != null) return trip.setMins;
  if (trip.mode === 'eta' && trip.etaMins != null) return trip.etaMins;
  return clockMins();
}
function nowMins() { return arrivalMins(); }
function durationMins() { return Math.min(trip.durH, 13) * 60; }
function isWeekend() {
  if (params.get('wknd')) return true;
  const day = new Date().getDay(); return day === 0 || day === 6;
}

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
map = L.map('map', { zoomControl: false }).setView([49.2606, -123.114], 13);
function setTiles() {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(darkMedia.matches ? TILES.dark : TILES.light, {
    maxZoom: 20, attribution: '© OpenStreetMap © CARTO',
  }).addTo(map);
}
setTiles();
darkMedia.addEventListener('change', setTiles);

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

Promise.all([
  fetch('data/meters.json').then((r) => r.json()),
  fetch('data/free.json').then((r) => r.json()).catch(() => []),
])
  .then(([m, f]) => {
    meters = m;
    freeBlocks = buildFreeBlocks(f);
    initLiveLabels();
    if (params.get('lat') && params.get('lon')) {
      run({ lat: +params.get('lat'), lon: +params.get('lon'), name: params.get('dest') || 'Dropped pin' }, true);
    } else if (params.get('dest')) {
      run(null, true);
    }
  })
  .catch(() => setStatus('Failed to load meter data. Run ./refresh.sh'));

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
async function geocodeOne(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ca&q=${encodeURIComponent(q + ', Vancouver, BC')}`;
  const r = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  // Nominatim is a free shared server; under load it returns 429/503. Flag those
  // as `busy` so run() can tell "server rate-limited us" from "place not found".
  if (!r.ok) { const e = new Error('geocode ' + r.status); e.busy = r.status === 429 || r.status === 503; throw e; }
  const j = await r.json();
  return j.length ? { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), name: j[0].display_name } : null;
}
async function geocode(q) {
  let loc = await geocodeOne(q);
  if (!loc && /\s(&|and|at|@|\/|x)\s|\s?&\s?/i.test(q)) {
    const first = q.split(/\s*(?:&|@|\/|\bat\b|\band\b|\bx\b)\s*/i)[0].trim();
    if (first) loc = await geocodeOne(first);
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

let current = [];
async function run(preLoc, isNew) {
  const q = $('dest').value.trim();
  if (!q && !preLoc) return;
  let loc = preLoc;
  if (!loc) {
    setStatus('Locating…');
    try { loc = await geocode(q); }
    catch (e) {
      setStatus(e.busy
        ? 'Search is busy right now — wait a moment and try again.'
        : 'Search is unavailable — check your connection and try again.');
      return;
    }
  }
  if (!loc) { setStatus('Could not find that place. Try an address or nearby landmark.'); return; }
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
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
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
  $('rcList').innerHTML = a.map((r, i) =>
    `<div class="rc-item" data-i="${i}"><span class="rc-ic">${PIN_SVG}</span>` +
    `<span class="rc-name">${esc(r.label)}</span>` +
    `<button class="rc-del" type="button" data-del="${i}" aria-label="Remove">${X_SVG}</button></div>`
  ).join('');
  return a.length;
}
function showRecents() { if (renderRecents()) $('recents').hidden = false; }
function hideRecents() { $('recents').hidden = true; }

$('dest').addEventListener('focus', showRecents);
// keep the panel open until you pick, clear, or tap away — not on every input blur
document.addEventListener('click', (e) => {
  if ($('recents').hidden) return;
  if (e.target.closest('#recents') || e.target.closest('#searchform')) return;
  hideRecents();
});
$('rcList').addEventListener('click', (e) => {
  const del = e.target.closest('.rc-del');
  if (del) {
    e.stopPropagation();   // rebuilding the list detaches this node — keep the outside-click closer from firing
    const a = loadRecents(); a.splice(+del.dataset.del, 1); saveRecents(a);
    if (!renderRecents()) hideRecents();
    return;
  }
  const item = e.target.closest('.rc-item');
  const r = item && loadRecents()[+item.dataset.i];
  if (!r) return;
  $('dest').value = r.label;
  $('dest').blur();
  hideRecents();
  run({ lat: r.lat, lon: r.lon, name: r.label }, true);
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
  const ranked = rankMeters(meters, { lat: loc.lat, lon: loc.lon, arrival, duration, maxWalkMin, sort: 'cheap' });
  current = ranked.slice(0, 40);   // kept only to frame the map around nearby spots

  if (labelLayer) labelLayer.setSelected(null);
  clearSpotLine();
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker([loc.lat, loc.lon], {
    // indigo teardrop — a distinct SHAPE so no price-pill color can camouflage it
    icon: L.divIcon({ className: '', html: '<svg class="destpin" width="34" height="34" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>', iconSize: [34, 34], iconAnchor: [17, 32] }),
    zIndexOffset: 2000,
  }).addTo(map);

  frameMap(loc, current);
}

// center on destination, keep the 3 closest spots in view (symmetric so dest stays centred)
function frameMap(loc, list) {
  const near = list.slice(0, 3);
  let dLat = 0.0016, dLon = 0.0022;
  for (const r of near) { dLat = Math.max(dLat, Math.abs(r.lat - loc.lat)); dLon = Math.max(dLon, Math.abs(r.lon - loc.lon)); }
  const bounds = [[loc.lat - dLat, loc.lon - dLon], [loc.lat + dLat, loc.lon + dLon]];
  map.fitBounds(bounds, {
    paddingTopLeft: [40, 120],
    paddingBottomRight: [40, 40],
    maxZoom: 17, animate: false,
  });
}

// ---- misc controls ----------------------------------------------------------
$('here').addEventListener('click', async () => {
  const pos = await getPosition();
  if (!pos) { alert('Could not get your location.'); return; }
  $('dest').value = 'My location';
  hideRecents();
  run({ lat: pos.lat, lon: pos.lon, name: 'My location' }, true);
});
$('searchform').addEventListener('submit', (e) => { e.preventDefault(); $('dest').blur(); hideRecents(); run(null, true); });

// ---- Free / Paid filters ------------------------------------------------------
function applyFilters() {
  if (labelLayer) labelLayer.setFilter(filters);
}
$('chipFree').addEventListener('click', () => { filters.free = !filters.free; $('chipFree').classList.toggle('on', filters.free); applyFilters(); });
$('chipPaid').addEventListener('click', () => { filters.paid = !filters.paid; $('chipPaid').classList.toggle('on', filters.paid); applyFilters(); });

// ---- Trip: arrival + duration -------------------------------------------------
function updatePill() {
  const arr = trip.mode === 'eta' && trip.etaMins != null ? fmtClock(trip.etaMins)
    : trip.mode === 'set' && trip.setMins != null ? fmtClock(trip.setMins) : 'Now';
  $('tpArr').textContent = arr;
  $('tpDur').textContent = durLabel(trip.durH);
}
function syncSeg() {
  $('tcArr').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === trip.mode));
  $('tcTime').hidden = trip.mode !== 'set';
}
// re-render everything the trip affects, WITHOUT reframing the map
function syncTrip() {
  updatePill(); syncSeg();
  if (labelLayer) labelLayer.refresh();           // pills reflect the arrival rate window
  if (cardBlock) showSpotCard(cardBlock);         // spot card totals reflect arrival + duration
}
$('tripPill').addEventListener('click', () => { $('tripcard').hidden = !$('tripcard').hidden; });
$('tcClose').addEventListener('click', () => { $('tripcard').hidden = true; });
$('tcArr').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.hidden) return;
  trip.mode = btn.dataset.m; trip.userSet = true;
  if (trip.mode === 'set') {
    if (trip.setMins == null) trip.setMins = clockMins();
    const t = $('tcTime');
    t.value = `${String(Math.floor(trip.setMins / 60)).padStart(2, '0')}:${String(trip.setMins % 60).padStart(2, '0')}`;
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
$('tcDur').addEventListener('input', () => {
  trip.durH = DUR_STOPS[+$('tcDur').value];
  $('tcDurV').textContent = durLabel(trip.durH);
  updatePill();
  if (cardBlock) showSpotCard(cardBlock);         // duration changes totals, not the pills
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
  driving.setSimTrack(r.coords);
  if (!driving.isActive()) driving.start(); else driving.setFollow(true);
  onNavFix(from);
}

async function onNavFix(pos) {
  const p = nav.update(pos);
  if (!p || !navTarget) return;
  if (p.arrived || distMeters(pos.lat, pos.lon, navTarget.lat, navTarget.lon) < 25) { endNav(true); return; }
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
  if (arrived) toast('You’ve arrived — pick a spot from the price pills.', 7000);
}

function toast(msg, ms = 5000) {
  const t = $('toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, ms);
}


// Clock formatter for schedule ranges: 540 -> "9am", 1080 -> "6pm", 1350 -> "10:30pm".
const fmtClock = (m) => {
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h >= 12 ? 'pm' : 'am');
};

// Full-day price schedule for a metered block: free before 9am, rate1 9am–6pm,
// rate2 6pm–10pm, free after 10pm — with adjacent equal-price windows merged so a
// flat all-day meter reads as one "9am–10pm" row instead of two identical ones.
function daySegments(b) {
  const raw = [
    { from: 0, to: ENF_START, rate: 0 },
    { from: ENF_START, to: MID, rate: b.rate1 || 0 },
    { from: MID, to: ENF_END, rate: b.rate2 || 0 },
    { from: ENF_END, to: 1440, rate: 0 },
  ];
  const segs = [];
  for (const s of raw) {
    const last = segs[segs.length - 1];
    if (last && last.rate === s.rate) last.to = s.to;
    else segs.push({ ...s });
  }
  return segs;
}

function segLabel(s) {
  if (s.from === 0) return 'Before ' + fmtClock(s.to);
  if (s.to === 1440) return 'After ' + fmtClock(s.from);
  return fmtClock(s.from) + '–' + fmtClock(s.to);
}

function renderSchedule(b, mins) {
  const el = $('scsched');
  const segs = daySegments(b);
  el.innerHTML = segs.map((s) => {
    const active = mins >= s.from && mins < s.to;
    const free = s.rate === 0;
    const cost = free ? 'Free' : `${fmtRate(s.rate)}/hr`;
    // "Now" only when arrival IS now; a planned arrival labels its window with the time
    const now = active ? `<span class="now">${trip.mode === 'now' ? 'Now' : fmtClock(mins)}</span>` : '';
    return `<div class="seg ${free ? 'free' : ''} ${active ? 'active' : ''}">` +
      `<span class="when">${segLabel(s)}${now}</span><span class="cost">${cost}</span></div>`;
  }).join('');
  el.hidden = false;
}

function showSpotCard(b) {
  cardBlock = b;
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
    $('spotcard').hidden = false;
    if (labelLayer) labelLayer.setSelected(b.id);
    return;
  }

  const r = rateNow(b.rate1, b.rate2, mins);
  $('scprice').textContent = r.free ? 'Free right now' : `${fmtRate(r.rate)}/hr`;
  $('scprice').classList.toggle('free', r.free);

  // full-day price breakdown so a "free right now" spot still shows its paid window
  renderSchedule(b, mins);

  const rows = [];
  // headline: what THIS stay actually costs, given the trip's arrival + duration
  const c = costFor(mins, durationMins(), b.rate1, b.rate2, b.flat);
  const durTxt = durLabel(trip.durH);
  rows.push(c.cost > 0
    ? `${IC.dollar} <b>≈ ${fmtRate(c.cost)}</b> for ${durTxt}${c.freeAfter ? ' · free after 10pm' : ''}`
    : `${IC.dollar} <b>Free</b> for your ${durTxt} stay`);
  if (b.flat != null) rows.push(`${IC.dollar} ${fmtRate(b.flat)} flat evening rate`);
  const lim = limitNow(b.limits, mins, isWeekend());
  if (lim != null && lim !== Infinity) {
    const eve = isWeekend() ? b.limits.wkndEve : b.limits.eve;
    const flip = mins < MID && eve != null && eve !== lim && eve !== Infinity ? ` · ${fmtLimit(eve)} after 6pm` : '';
    rows.push(`${IC.clock} Max stay <b>${fmtLimit(lim)}</b>${flip}`);
  } else if (lim === Infinity) {
    rows.push(`${IC.clock} No time limit`);
  }
  const tow = towSoon(b, mins, 24 * 60);
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
  $('spotcard').hidden = false;
  if (labelLayer) labelLayer.setSelected(b.id);
}
$('scclose').addEventListener('click', () => { $('spotcard').hidden = true; cardBlock = null; clearSpotLine(); if (labelLayer) labelLayer.setSelected(null); });

function updateRecenter() {
  const show = driving.isActive() ? !driving.isFollowing() : false;
  $('recenter').classList.toggle('show', show);
}

function initLiveLabels() {
  blocks = buildBlocks(meters).concat(freeBlocks);
  labelLayer = createLabelLayer(map, blocks, { nowMins, isWeekend, onTap: showSpotCard });
  labelLayer.refresh();
  nav = createNav({ map });

  driving = createDriving({
    map,
    onFix(pos) {
      labelLayer.setFocus(pos);
      if (nav.isActive()) onNavFix(pos);
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
  $('scstart').addEventListener('click', () => { if (cardBlock) startNav(cardBlock); });
  $('recenter').addEventListener('click', async () => {
    if (driving.isActive()) { driving.setFollow(true); return; }
    const pos = await getPosition();
    if (pos) map.setView([pos.lat, pos.lon], 16);
    else toast('Could not get your location.');
  });
  updateRecenter();
  window.__pk = { map, layer: labelLayer, driving, blocks };  // debug handle
  if (params.get('sim')) driving.start();
}
