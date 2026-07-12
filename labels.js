// Block-face clustering + always-visible price labels.
// Clusters the ~3,758 meters once at load into block-face groups (same rate/limit
// tuple within 45 m), then renders a zoom-laddered label layer:
//   z>=16  meter dots + one "$3 · 2h" pill per block face
//   z==15  faded dots + price-only pills, decluttered, capped
//   z13-14 ~300 m cells labeled with the area minimum ("from $2")
//   z<13   nothing
// Only real, currently-parkable spots render: non-"Any Vehicle" meters are dropped
// at cluster time; blocks inside an active tow-away rush window are hidden.
import {
  parseMoney, parseTimeLimit, parseRange, distMeters,
  rateNow, limitNow, bandRateNow, inRange,
  parseProhibitions, prohibitionNow,
} from './rank.js?v=15';

// Seattle prices by blockface (a line + a midpoint), not per-meter points. Each record
// is already one "block"; we reuse the whole pill/declutter/zoom machinery but draw a
// polyline instead of meter dots, and price it from time-of-day bands (see rateFor).
export function buildSeattleBlocks(records, idBase = 2e6) {
  return records.map((o, i) => ({
    id: idBase + i,
    lat: o.mid[1], lon: o.mid[0],                      // midpoint: pill anchor + distance
    line: o.line.map(([lon, lat]) => [lat, lon]),      // GeoJSON [lon,lat] → Leaflet [lat,lon]
    bands: { wkd: o.wkd, sat: o.sat, sun: o.sun },
    limitMin: o.limit || null,
    cat: o.cat, spaces: o.spaces, hblock: o.h,
    pts: [], rushes: [], card: false,                  // no meter dots / rush windows in Seattle
  }));
}

// San Francisco: point meters (like Vancouver → dots via `pts`, no `line`) priced by
// time-of-day bands (like Seattle → rateFor/limitFor/schedule dispatch on `bands`). Each
// record is already one block (meters pre-grouped in build-sf.py). No fresh per-meter time-
// limit feed exists for SF, so limitMin stays null → pills show price only, cards omit max-stay.
export function buildSFBlocks(records, idBase = 4e6) {
  return records.map((o, i) => ({
    id: idBase + i,
    lat: o.lat, lon: o.lon,                            // block centroid: pill anchor + distance
    pts: o.pts,                                        // meter points → dots (rendered like Vancouver)
    bands: { wkd: o.wkd, sat: o.sat, sun: o.sun },
    limitMin: null,                                    // no current SF time-limit source (see build-sf.py)
    spaces: o.spaces, hblock: o.h,
    rushes: [], card: false,                           // no meter-level rush windows in SF
  }));
}

const EMPTY_BANDS = { wkd: [], sat: [], sun: [] };   // always-free blockface (no paid hours)

// Seattle's free layer: unrestricted (free, unlimited) + time-limited (free, capped).
// No rate bands, so they read as free at every hour. Unrestricted blocks are line-only
// (noPill) — 30k "$0" pills would bury the map; the blue line already says "free here".
export function buildSeattleFreeBlocks(records, idBase = 3e6) {
  return records.map((o, i) => ({
    id: idBase + i,
    lat: o.mid[1], lon: o.mid[0],
    line: o.line.map(([lon, lat]) => [lat, lon]),
    bands: EMPTY_BANDS,
    freeLimit: o.cat === 'tl' ? (o.limit || null) : null,   // time-limited: free but capped
    noPill: o.cat !== 'tl',                                  // unrestricted: draw the line, skip the pill
    cat: o.cat, spaces: o.spaces, hblock: o.h,
    pts: [], rushes: [], card: false,
  }));
}

// Current rate for a block, dispatching on shape: Seattle blockfaces carry `bands`,
// Vancouver meters/free carry rate1/rate2.
function rateFor(bl, mins, dow) {
  return bl.bands ? bandRateNow(bl.bands, mins, dow) : rateNow(bl.rate1, bl.rate2, mins);
}
function limitFor(bl, mins, dow, wknd) {
  if (bl.bands) {   // Seattle: paid limit while metered; free-but-capped (time-limited) otherwise
    return rateFor(bl, mins, dow).free ? (bl.freeLimit || null) : bl.limitMin;
  }
  return limitNow(bl.limits, mins, wknd);
}

const JOIN_M = 45;                 // meters sharing a tuple within this join one block face
const CELL_LAT = 0.00045, CELL_LON = 0.00065;   // ~50 m spatial hash
const LABEL_CAP = 150;

export function buildBlocks(meters) {
  const blocks = [];
  const grid = new Map();
  for (const m of meters) {
    if (m.service_status !== 'In Service') continue;
    if (m.vehicle_type && m.vehicle_type !== 'Any Vehicle') continue;
    const g = m.geo_point_2d;
    if (!g) continue;
    const key = [m.rate_9am_6pm, m.rate_6pm_10pm, m.flat_rate, m.time_limit_9am_6pm,
      m.time_limit_6pm_10pm, m.direction].join('|');
    const ci = Math.floor(g.lat / CELL_LAT), cj = Math.floor(g.lon / CELL_LON);
    let target = null;
    outer:
    for (let di = -1; di <= 1 && !target; di++) for (let dj = -1; dj <= 1; dj++) {
      const cell = grid.get((ci + di) + ',' + (cj + dj));
      if (!cell) continue;
      for (const bi of cell) {
        const b = blocks[bi];
        if (b.key === key && distMeters(b.lat, b.lon, g.lat, g.lon) <= JOIN_M) { target = b; break outer; }
      }
    }
    const proh = parseProhibitions(m);   // NO STOPPING / loading / permit-only windows for this meter
    if (!target) {
      target = {
        id: blocks.length, key, lat: g.lat, lon: g.lon, count: 0, spaces: 0, pts: [],
        rate1: parseMoney(m.rate_9am_6pm), rate2: parseMoney(m.rate_6pm_10pm),
        flat: parseMoney(m.flat_rate),
        limits: {
          day: parseTimeLimit(m.time_limit_9am_6pm), eve: parseTimeLimit(m.time_limit_6pm_10pm),
          wkndDay: parseTimeLimit(m.time_limit_weekend_9am_6pm), wkndEve: parseTimeLimit(m.time_limit_weekend_6pm_10pm),
        },
        rushes: [parseRange(m.am_rush_hours), parseRange(m.pm_rush_hours)].filter(Boolean),
        prohibitions: proh,
        card: /yes/i.test(m.credit_card || ''),
      };
      blocks.push(target);
      const ck = ci + ',' + cj;
      if (!grid.has(ck)) grid.set(ck, []);
      grid.get(ck).push(target.id);
    } else {
      // meters on one joined face can differ in restriction — union their windows so a
      // loading/no-stopping zone is never lost when merged with an unrestricted meter.
      for (const q of proh) {
        if (!target.prohibitions.some((x) => x.zone === q.zone && x.start === q.start && x.end === q.end && x.days === q.days))
          target.prohibitions.push(q);
      }
    }
    target.lat = (target.lat * target.count + g.lat) / (target.count + 1);
    target.lon = (target.lon * target.count + g.lon) / (target.count + 1);
    target.count++;
    target.spaces += /twin/i.test(m.meter_head || '') ? 2 : 1;
    target.pts.push([g.lat, g.lon]);
  }
  return blocks;
}

export function towActive(block, mins) {
  return block.rushes.some((r) => inRange(r, mins));
}

// Next rush window that starts within `withinMin` minutes, or null.
export function towSoon(block, mins, withinMin = 90) {
  for (const r of block.rushes) {
    if (r[0] > mins && r[0] - mins <= withinMin) return r;
  }
  return null;
}

export const fmtRate = (r) => '$' + (r % 1 ? r.toFixed(2) : String(r));
export const fmtLimit = (l) => l == null || l === Infinity ? '' : (l >= 60 ? (l / 60) + 'h' : l + 'm');
export const bucket = (rate, free) =>
  free ? 'p-free' : rate <= 2 ? 'p1' : rate <= 4 ? 'p2' : rate <= 6 ? 'p3' : 'p4';

export function createLabelLayer(map, blocks, { nowMins, isWeekend, dow, onTap, flagState }) {
  const dowNow = dow || (() => new Date().getDay());
  // flagState(block) -> { flagged, hidden } from crowd reports; default: no flags.
  const flags = flagState || (() => ({}));
  const pillCache = new Map();      // sig -> maplibregl.Marker
  const pillByBlock = new Map();    // block.id -> currently-shown pill marker
  let selectedId = null, selMarker = null;
  let firstPaint = true;            // fade the pills in only on the cold app load; zooming/panning into new areas stays still
  let filter = { free: true, paid: true };
  const keep = (free) => (free && filter.free) || (!free && filter.paid);
  let focus = null;                 // car position while driving

  // Meter dots + Seattle blockface lines are GPU GeoJSON layers (installed by app.js). We only
  // push FeatureCollections into them; setData is cheap even for thousands of features.
  const EMPTY_LABEL_FC = { type: 'FeatureCollection', features: [] };
  const setDotData = (fc) => { const s = map.getSource('meter-dots'); if (s) s.setData(fc); };
  const setLineData = (fc) => { const s = map.getSource('blockface-lines'); if (s) s.setData(fc); };
  const DOT_COLOR = { 'p-free': '#2563eb', p1: '#16a34a', p2: '#d97706', p3: '#ea580c', p4: '#dc2626' };
  const zoomInt = () => Math.round(map.getZoom());   // MapLibre zoom is fractional; the ladders want an int
  const project = (lat, lon) => map.project([lon, lat]);   // → {x,y} screen px (already rotation-aware)

  // Highlight the selected block's pill in its active (darker-tier) state.
  function applySel() {
    if (selMarker) {
      const el = selMarker.getElement();
      if (el && el.firstElementChild) el.firstElementChild.classList.remove('sel');
      el.style.zIndex = '';
      selMarker = null;
    }
    if (selectedId == null) return;
    const mk = pillByBlock.get(selectedId);
    if (!mk) return;
    const el = mk.getElement();
    if (el && el.firstElementChild) el.firstElementChild.classList.add('sel');
    if (el) el.style.zIndex = '500';   // lift above every other pill
    selMarker = mk;
  }

  function visibleActive(mins, dow) {
    // pad the viewport ~10% so pills/dots don't pop right at the edge
    const b = map.getBounds();
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    const dLat = (n - s) * 0.1, dLon = (e - w) * 0.1;
    return blocks.filter((bl) =>
      bl.lat > s - dLat && bl.lat < n + dLat &&
      bl.lon > w - dLon && bl.lon < e + dLon && !towActive(bl, mins) &&
      !prohibitionNow(bl, mins, dow) &&   // NO STOPPING / loading / permit-only active now → not parkable
      !flags(bl).hidden);   // 3+ reports → gone from pills, dots and cluster minimums alike
  }

  function pillDesired(z, mins, wknd, dow) {
    const vis = visibleActive(mins, dow);
    const ctr = focus || map.getCenter();
    const ctrLat = ctr.lat, ctrLon = ctr.lng != null ? ctr.lng : ctr.lon;

    if (z < 13) return [];   // dots paint the coverage; no text this far out

    if (z <= 14) {   // area minimum per ~800 m cell — sparse chips over the dot texture
      // nearly every cell contains SOME free block, so a plain minimum would read "$0"
      // everywhere — instead the chip is "$0" only where free dominates, else cheapest paid.
      const cells = new Map();
      for (const bl of vis) {
        const ck = Math.floor(bl.lat / 0.0072) + ',' + Math.floor(bl.lon / 0.011);
        const r = rateFor(bl, mins, dow);
        if (!keep(r.free)) continue;
        let c = cells.get(ck);
        if (!c) { c = { nFree: 0, nPaid: 0, minPaid: Infinity, lat: bl.lat, lon: bl.lon }; cells.set(ck, c); }
        if (r.free) c.nFree++;
        else { c.nPaid++; if (r.rate < c.minPaid) c.minPaid = r.rate; }
      }
      const items = [];
      for (const [ck, c] of cells) {
        const free = c.nFree >= c.nPaid;
        if (!free && c.minPaid === Infinity) continue;
        const text = free ? 'Free' : fmtRate(c.minPaid);
        items.push({
          sig: 'g' + ck + '|' + text, lat: c.lat, lon: c.lon, text, cluster: true,
          cls: bucket(free ? 0 : c.minPaid, free), block: null,
          d: distMeters(ctrLat, ctrLon, c.lat, c.lon),
        });
      }
      items.sort((a, b) => a.d - b.d);   // chips near the center win the space
      const kept = [], keptPx = [];
      for (const it of items) {
        if (kept.length >= 12) break;
        const px = project(it.lat, it.lon);
        let clash = false;
        for (const k of keptPx) {
          if (Math.abs(k.x - px.x) < 78 && Math.abs(k.y - px.y) < 40) { clash = true; break; }
        }
        if (clash) continue;
        kept.push(it); keptPx.push(px);
      }
      return kept;
    }

    const items = vis.filter((bl) => !bl.noPill).map((bl) => {   // free streets: line only, no pill
      const r = rateFor(bl, mins, dow);
      const lim = z >= 16 ? limitFor(bl, mins, dow, wknd) : null;
      const limTxt = lim != null && lim !== Infinity ? ' · ' + fmtLimit(lim) : '';
      const price = r.free ? 'Free' : fmtRate(r.rate);
      // dimmed suffix = per-hour unit + max-stay, e.g. "/hr · 2h". The "/hr" names the price's
      // unit so "$8 · 2h" can't be misread as "$8 for two hours"; free spots take no unit.
      const suffix = (r.free ? '' : '/hr') + limTxt;
      const text = price + suffix;
      const flagged = !!flags(bl).flagged;
      return {
        sig: 'b' + bl.id + '|' + text + (flagged ? '!' : ''), lat: bl.lat, lon: bl.lon, text, price, suffix, free: r.free,
        cls: bucket(r.rate, r.free), block: bl, rate: r.rate, flagged,
        d: distMeters(ctrLat, ctrLon, bl.lat, bl.lon),
      };
    }).filter((it) => keep(it.free));
    items.sort(z === 15 ? (a, b) => a.rate - b.rate || a.d - b.d : (a, b) => a.d - b.d);

    const kept = [], keptPx = [];
    for (const it of items) {
      if (kept.length >= LABEL_CAP) break;
      const px = project(it.lat, it.lon);
      let clash = false;
      for (const k of keptPx) {
        if (Math.abs(k.x - px.x) < 56 && Math.abs(k.y - px.y) < 26) { clash = true; break; }
      }
      if (clash) continue;
      kept.push(it); keptPx.push(px);
    }
    return kept;
  }

  // Dots (meters) + lines (Seattle blockfaces) as GeoJSON. Radius/opacity/width ride zoom-
  // interpolated paint expressions in app.js's layer defs, so here we only decide WHICH features
  // show (in view, active, passing the free/paid filter) and their color.
  function refreshDots(z, mins, dow) {
    if (z < 11) { setDotData(EMPTY_LABEL_FC); setLineData(EMPTY_LABEL_FC); return; }
    const dots = [], lines = [];
    for (const bl of visibleActive(mins, dow)) {
      const r = rateFor(bl, mins, dow);
      if (!keep(r.free)) continue;
      const col = DOT_COLOR[bucket(r.rate, r.free)];
      if (bl.line) {   // Seattle blockface — draw the side of the street, colored by rate ([lat,lon]→[lon,lat])
        lines.push({ type: 'Feature', properties: { color: col },
          geometry: { type: 'LineString', coordinates: bl.line.map(([la, lo]) => [lo, la]) } });
      } else {
        const pts = bl.pts.length ? bl.pts : [[bl.lat, bl.lon]];   // free blocks have no meter points
        for (const [la, lo] of pts) {
          dots.push({ type: 'Feature', properties: { color: col }, geometry: { type: 'Point', coordinates: [lo, la] } });
        }
      }
    }
    setDotData({ type: 'FeatureCollection', features: dots });
    setLineData({ type: 'FeatureCollection', features: lines });
  }

  function refresh() {
    const t0 = performance.now();
    const z = zoomInt();
    const mins = nowMins(), wknd = isWeekend(), dw = dowNow();
    const desired = z >= 13 ? pillDesired(z, mins, wknd, dw) : [];

    const want = new Set(desired.map((d) => d.sig));
    for (const [sig, mk] of pillCache) {
      if (!want.has(sig)) { mk.remove(); pillCache.delete(sig); }
    }
    pillByBlock.clear();
    let dropN = 0;   // staggered-entrance index among pills newly created this refresh (nearest first — `desired` is distance-sorted)
    for (const d of desired) {
      let mk = pillCache.get(d.sig);
      if (!mk) {
        const warn = d.flagged ? '<span class="pf">!</span>' : '';
        const body = d.suffix ? `${d.price}<span class="plim">${d.suffix}</span>` : d.text;
        // 0-size wrapper element; the .plabel inside positions itself above the point (its CSS
        // translate). MapLibre keeps the wrapper screen-upright on rotate automatically.
        const el = document.createElement('div');
        if (d.cluster) el.className = 'cluster';
        el.innerHTML = `<div class="plabel ${d.cls}${d.flagged ? ' flag' : ''}">${warn}${body}</div>`;
        mk = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([d.lon, d.lat]).addTo(map);
        if (d.block) el.addEventListener('click', () => onTap(d.block));
        // area chip → zoom in so its individual block pills appear
        else if (d.cluster) el.addEventListener('click', () => map.easeTo({ center: [d.lon, d.lat], zoom: 16, duration: 500 }));
        // pop the new pill in with a small nearest-first stagger (25ms step, capped so a
        // big batch never drags on). Cached pills that merely re-appear on pan don't re-run.
        // fade the drop-in only on the cold load; later refreshes (zoom/pan/filter) render instantly.
        const pill = firstPaint ? el.firstElementChild : null;
        if (pill) {
          pill.style.animationDelay = Math.min(dropN, 14) * 25 + 'ms';
          pill.classList.add('in');
          // drop the class once it lands so a later selection can spring cleanly
          // (both .in and .sel set `animation`; a lingering .in would win the cascade)
          pill.addEventListener('animationend', () => pill.classList.remove('in'), { once: true });
          dropN++;
        }
        pillCache.set(d.sig, mk);
      }
      if (d.block) pillByBlock.set(d.block.id, mk);
    }
    refreshDots(z, mins, dw);
    applySel();
    firstPaint = false;             // cold load done — every later refresh renders pills instantly
    layer.lastRefreshMs = performance.now() - t0;
  }

  map.on('moveend', refresh);
  map.on('zoomend', refresh);
  const timer = setInterval(refresh, 60000);
  const layer = {
    refresh,
    lastRefreshMs: 0,
    setSelected(id) { selectedId = id; applySel(); },
    setFilter(f) { filter = f; refresh(); },
    setFocus(pos) { focus = pos; },
    destroy() { clearInterval(timer); map.off('moveend', refresh); map.off('zoomend', refresh); },
  };
  return layer;
}
