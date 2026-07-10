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
} from './rank.js?v=14';

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
        card: /yes/i.test(m.credit_card || ''),
      };
      blocks.push(target);
      const ck = ci + ',' + cj;
      if (!grid.has(ck)) grid.set(ck, []);
      grid.get(ck).push(target.id);
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
  map.createPane('mdots').style.zIndex = 610;
  map.createPane('pills').style.zIndex = 620;
  const canvas = L.canvas({ pane: 'mdots', padding: 0.3 });
  const pillCache = new Map();      // sig -> marker
  const pillByBlock = new Map();    // block.id -> currently-shown pill marker
  let selectedId = null, selMarker = null;
  let firstPaint = true;            // fade the pills in only on the cold app load; zooming/panning into new areas stays still
  let filter = { free: true, paid: true };
  const keep = (free) => (free && filter.free) || (!free && filter.paid);
  let dotGroup = null;
  let focus = null;                 // car position while driving

  // Highlight the selected block's pill in its active (darker-tier) state.
  function applySel() {
    if (selMarker) {
      const el = selMarker.getElement();
      if (el && el.firstElementChild) el.firstElementChild.classList.remove('sel');
      selMarker.setZIndexOffset(0);
      selMarker = null;
    }
    if (selectedId == null) return;
    const mk = pillByBlock.get(selectedId);
    if (!mk) return;
    const el = mk.getElement();
    if (el && el.firstElementChild) el.firstElementChild.classList.add('sel');
    mk.setZIndexOffset(10000);   // lift above every other pill
    selMarker = mk;
  }

  function visibleActive(mins) {
    const b = map.getBounds().pad(0.1);
    return blocks.filter((bl) =>
      bl.lat > b.getSouth() && bl.lat < b.getNorth() &&
      bl.lon > b.getWest() && bl.lon < b.getEast() && !towActive(bl, mins) &&
      !flags(bl).hidden);   // 3+ reports → gone from pills, dots and cluster minimums alike
  }

  function pillDesired(z, mins, wknd, dow) {
    const vis = visibleActive(mins);
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
        const text = free ? '$0' : fmtRate(c.minPaid);
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
        const px = map.latLngToContainerPoint([it.lat, it.lon]);
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
      const price = r.free ? '$0' : fmtRate(r.rate);
      const text = price + limTxt;
      const flagged = !!flags(bl).flagged;
      return {
        sig: 'b' + bl.id + '|' + text + (flagged ? '!' : ''), lat: bl.lat, lon: bl.lon, text, price, limTxt, free: r.free,
        cls: bucket(r.rate, r.free), block: bl, rate: r.rate, flagged,
        d: distMeters(ctrLat, ctrLon, bl.lat, bl.lon),
      };
    }).filter((it) => keep(it.free));
    items.sort(z === 15 ? (a, b) => a.rate - b.rate || a.d - b.d : (a, b) => a.d - b.d);

    const kept = [], keptPx = [];
    for (const it of items) {
      if (kept.length >= LABEL_CAP) break;
      const px = map.latLngToContainerPoint([it.lat, it.lon]);
      let clash = false;
      for (const k of keptPx) {
        if (Math.abs(k.x - px.x) < 56 && Math.abs(k.y - px.y) < 26) { clash = true; break; }
      }
      if (clash) continue;
      kept.push(it); keptPx.push(px);
    }
    return kept;
  }

  function refreshDots(z, mins, dow) {
    if (dotGroup) { map.removeLayer(dotGroup); dotGroup = null; }
    if (z < 11) return;
    const op = z >= 16 ? 0.9 : z >= 15 ? 0.4 : 0.6;
    const rad = z >= 16 ? 3.5 : z >= 15 ? 2.5 : 3;
    const lw = z >= 16 ? 5 : z >= 14 ? 4 : 3;                 // blockface line weight by zoom
    const lineOp = z >= 16 ? 0.5 : z >= 14 ? 0.42 : 0.35;    // soft heatmap — the pills carry the price
    const marks = [];
    for (const bl of visibleActive(mins)) {
      const r = rateFor(bl, mins, dow);
      if (!keep(r.free)) continue;
      const col = { 'p-free': '#2563eb', p1: '#16a34a', p2: '#d97706', p3: '#ea580c', p4: '#dc2626' }[bucket(r.rate, r.free)];
      if (bl.line) {   // Seattle blockface — draw the side of the street, colored by rate
        marks.push(L.polyline(bl.line, {
          renderer: canvas, color: col, weight: lw, opacity: lineOp,
          lineCap: 'round', interactive: false,
        }));
      } else {
        const pts = bl.pts.length ? bl.pts : [[bl.lat, bl.lon]];   // free blocks have no meter points
        for (const [la, lo] of pts) {
          marks.push(L.circleMarker([la, lo], {
            renderer: canvas, radius: rad, stroke: false, fillColor: col, fillOpacity: op, interactive: false,
          }));
        }
      }
    }
    dotGroup = L.layerGroup(marks).addTo(map);
  }

  function refresh() {
    const t0 = performance.now();
    const z = map.getZoom();
    const mins = nowMins(), wknd = isWeekend(), dw = dowNow();
    const desired = z >= 13 ? pillDesired(z, mins, wknd, dw) : [];

    const want = new Set(desired.map((d) => d.sig));
    for (const [sig, mk] of pillCache) {
      if (!want.has(sig)) { map.removeLayer(mk); pillCache.delete(sig); }
    }
    pillByBlock.clear();
    let dropN = 0;   // staggered-entrance index among pills newly created this refresh (nearest first — `desired` is distance-sorted)
    for (const d of desired) {
      let mk = pillCache.get(d.sig);
      if (!mk) {
        const warn = d.flagged ? '<span class="pf">!</span>' : '';
        const body = d.limTxt ? `${d.price}<span class="plim">${d.limTxt}</span>` : d.text;
        mk = L.marker([d.lat, d.lon], {
          pane: 'pills', interactive: !!d.block || !!d.cluster, keyboard: false,
          icon: L.divIcon({ className: `${d.cluster ? 'cluster' : ''}`, html: `<div class="plabel ${d.cls}${d.flagged ? ' flag' : ''}">${warn}${body}</div>`, iconSize: [0, 0] }),
        }).addTo(map);
        if (d.block) mk.on('click', () => onTap(d.block));
        // area chip → zoom in so its individual block pills appear
        else if (d.cluster) mk.on('click', () => map.setView([d.lat, d.lon], 16, { animate: true }));
        // pop the new pill in with a small nearest-first stagger (25ms step, capped so a
        // big batch never drags on). Cached pills that merely re-appear on pan don't re-run.
        // fade the drop-in only on the cold load; later refreshes (zoom/pan/filter) render instantly.
        const pill = firstPaint ? mk.getElement()?.firstElementChild : null;
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

  map.on('moveend zoomend', refresh);
  const timer = setInterval(refresh, 60000);
  const layer = {
    refresh,
    lastRefreshMs: 0,
    setSelected(id) { selectedId = id; applySel(); },
    setFilter(f) { filter = f; refresh(); },
    setFocus(pos) { focus = pos; },
    destroy() { clearInterval(timer); map.off('moveend zoomend', refresh); },
  };
  return layer;
}
