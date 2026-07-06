import { rankMeters } from './rank.js?v=8';

const $ = (id) => document.getElementById(id);
const TOPN = 5;
let meters = [];
let map, tileLayer, markers = [], destMarker, lastLoc = null, cachedPos = null;
let sheetSnaps = null;

const params = new URLSearchParams(location.search);
if (params.get('dest')) $('dest').value = params.get('dest');
if (params.get('dur')) { $('dur').value = params.get('dur'); }
if (params.get('walk')) { $('walk').value = params.get('walk'); }
const fmtDur = (v) => `${parseFloat(v)}h`;
$('durval').textContent = fmtDur($('dur').value);
$('walkval').textContent = $('walk').value;
$('dur').addEventListener('input', (e) => $('durval').textContent = fmtDur(e.target.value));
$('walk').addEventListener('input', (e) => $('walkval').textContent = e.target.value);
const rerun = () => { if (lastLoc) rankAndRender(lastLoc, false); };
$('dur').addEventListener('change', rerun);
$('walk').addEventListener('change', rerun);
// arrival is always "now" — you're parking now
function nowMins() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
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

fetch('data/meters.json')
  .then((r) => r.json())
  .then((d) => {
    meters = d;
    if (params.get('lat') && params.get('lon')) {
      run({ lat: +params.get('lat'), lon: +params.get('lon'), name: params.get('dest') || 'Dropped pin' }, true);
    } else if (params.get('dest')) {
      run(null, true);
    }
  })
  .catch(() => setStatus('Failed to load meter data. Run ./refresh.sh'));

function setStatus(msg) { $('results').innerHTML = `<div class="status">${msg}</div>`; }

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
  const j = await fetch(url, { headers: { 'Accept-Language': 'en' } }).then((r) => r.json());
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
function clearMap() { markers.forEach((m) => map.removeLayer(m)); markers = []; }

let current = [];
async function run(preLoc, isNew) {
  const q = $('dest').value.trim();
  if (!q && !preLoc) return;
  let loc = preLoc;
  if (!loc) { setStatus('Locating…'); try { loc = await geocode(q); } catch { loc = null; } }
  if (!loc) { setStatus('Could not find that place. Try an address or nearby landmark.'); return; }
  lastLoc = loc;
  rankAndRender(loc, isNew);
}

function rankAndRender(loc, isNew) {
  const arrival = nowMins();
  const duration = Math.round(parseFloat($('dur').value) * 60);
  const maxWalkMin = parseInt($('walk').value);
  const ranked = rankMeters(meters, { lat: loc.lat, lon: loc.lon, arrival, duration, maxWalkMin, sort: 'cheap' });
  current = ranked.slice(0, 40);

  clearMap();
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker([loc.lat, loc.lon], {
    icon: L.divIcon({ className: '', html: '<div class="destpin"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    zIndexOffset: 2000,
  }).addTo(map);

  current.forEach((r, i) => {
    const top = i < TOPN;
    const size = top ? 30 : 12;
    const html = top ? `<div class="pin" data-i="${i}">${i + 1}</div>` : `<div class="dot" data-i="${i}"></div>`;
    const mk = L.marker([r.lat, r.lon], {
      icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      zIndexOffset: top ? 1000 - i : 0,
    }).addTo(map);
    mk.on('click', () => select(i, true));
    markers.push(mk);
    r._marker = mk;
  });

  frameMap(loc, current);
  renderList(current);
  if (isNew) collapseSheet();
}

// center on destination, keep the 3 closest spots in view (symmetric so dest stays centred)
function frameMap(loc, list) {
  const near = list.slice(0, 3);
  let dLat = 0.0016, dLon = 0.0022;
  for (const r of near) { dLat = Math.max(dLat, Math.abs(r.lat - loc.lat)); dLon = Math.max(dLon, Math.abs(r.lon - loc.lon)); }
  const bounds = [[loc.lat - dLat, loc.lon - dLon], [loc.lat + dLat, loc.lon + dLon]];
  const mobile = window.innerWidth < 760;
  map.fitBounds(bounds, {
    paddingTopLeft: [40, 90],
    paddingBottomRight: [40, mobile ? Math.round(window.innerHeight * 0.46) : 40],
    maxZoom: 17, animate: false,
  });
}

function select(i, fromMap) {
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', +c.dataset.i === i));
  document.querySelectorAll('.pin, .dot').forEach((p) => p.classList.toggle('sel', +p.dataset.i === i));
  if (fromMap) { expandSheet(); const card = document.querySelector(`.card[data-i="${i}"]`); if (card) card.scrollIntoView({ block: 'nearest' }); }
  else { map.panTo([current[i].lat, current[i].lon]); }
}

function renderList(list) {
  if (!list.length) { setStatus('No meters within that walk time. Try a longer walk.'); return; }
  $('results').innerHTML = list.map((r, i) => {
    const price = r.free ? 'FREE' : '$' + r.cost.toFixed(2);
    const tags = [];
    if (r.free) tags.push('<span class="tag free">free your whole stay</span>');
    else if (r.freeAfter) tags.push('<span class="tag free">free after 10 PM</span>');
    if (r.blockCount >= 6) tags.push(`<span class="tag">${r.blockCount} spots on block</span>`);
    if (r.flat != null) tags.push(`<span class="tag">$${r.flat.toFixed(2)} flat</span>`);
    if (r.overLimit) tags.push(`<span class="tag">over ${r.limit / 60}h limit</span>`);
    return `<div class="card" data-i="${i}">
      <div class="num ${i < TOPN ? '' : 'dim'}">${i + 1}</div>
      <div class="body">
        <div class="price ${r.free ? 'free' : ''}">${price}<span class="sub" style="display:inline;margin-left:8px">${r.hourlyNow ? '$' + r.hourlyNow.toFixed(2) + '/hr now' : 'free now'}</span></div>
        <div class="sub">${r.walkMin} min walk ${r.dir} · ${r.distM} m away</div>
        <div class="tags">${tags.join('')}</div>
      </div>
      <a class="dir" href="${navUrl(r)}" target="_blank" rel="noopener" aria-label="Navigate">
        <span class="btn">${NAV_SVG}</span><span class="t">${r.walkMin} min</span>
      </a>
    </div>`;
  }).join('');
  document.querySelectorAll('.card').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.dir')) return;
    const i = +el.dataset.i;
    select(i, false);
    map.setView([current[i].lat, current[i].lon], 17);
  }));
  computeSnaps();
}

// ---- draggable bottom sheet (mobile) ----------------------------------------
// Track height in `curH` instead of reading offsetHeight — reading it mid-transition
// returns the stale (pre-animation) value and breaks the snap decision.
const sheet = $('sheet');
let curH = null;
function isMobile() { return window.innerWidth < 760; }
function setSheetHeight(h, animate) {
  sheet.style.transition = animate ? 'height .25s ease' : 'none';
  sheet.style.height = h + 'px';
  curH = h;
}
function computeSnaps() {
  if (!isMobile()) { sheet.style.height = ''; sheet.style.transition = ''; sheetSnaps = null; curH = null; return; }
  const expanded = Math.round(window.innerHeight * 0.86);
  const gripH = 24;
  const tripH = document.querySelector('.trip').offsetHeight;
  const firstCard = document.querySelector('.card');
  const collapsed = Math.min(expanded, gripH + tripH + (firstCard ? firstCard.offsetHeight : 96) + 4);
  sheetSnaps = { collapsed, expanded };
}
function collapseSheet() { if (sheetSnaps) setSheetHeight(sheetSnaps.collapsed, true); }
function expandSheet() { if (sheetSnaps) setSheetHeight(sheetSnaps.expanded, true); }

const grip = $('grip');
let dragY = null, dragH = 0, lastH = 0;
function dStart(y) {
  if (!isMobile() || !sheetSnaps) return;
  dragY = y; dragH = curH != null ? curH : sheetSnaps.collapsed; lastH = dragH;
  sheet.style.transition = 'none';
}
function dMove(y) {
  if (dragY == null) return;
  let h = dragH + (dragY - y);
  h = Math.max(sheetSnaps.collapsed * 0.7, Math.min(sheetSnaps.expanded, h));
  sheet.style.height = h + 'px';
  curH = h; lastH = h;
}
function dEnd() {
  if (dragY == null) return;
  const mid = (sheetSnaps.collapsed + sheetSnaps.expanded) / 2;
  setSheetHeight(lastH < mid ? sheetSnaps.collapsed : sheetSnaps.expanded, true);
  dragY = null;
}
grip.addEventListener('touchstart', (e) => dStart(e.touches[0].clientY), { passive: true });
grip.addEventListener('touchmove', (e) => dMove(e.touches[0].clientY), { passive: true });
grip.addEventListener('touchend', dEnd);
grip.addEventListener('mousedown', (e) => {
  dStart(e.clientY);
  const mm = (ev) => dMove(ev.clientY);
  const mu = () => { dEnd(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
  document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
});
window.addEventListener('resize', () => { computeSnaps(); if (sheetSnaps && sheet.offsetHeight > sheetSnaps.expanded) sheet.style.height = sheetSnaps.expanded + 'px'; });

// ---- misc controls ----------------------------------------------------------
$('here').addEventListener('click', async () => {
  const pos = await getPosition();
  if (!pos) { alert('Could not get your location.'); return; }
  $('dest').value = 'My location';
  run({ lat: pos.lat, lon: pos.lon, name: 'My location' }, true);
});
$('searchform').addEventListener('submit', (e) => { e.preventDefault(); $('dest').blur(); run(null, true); });
