// Core parking scoring logic — pure functions, no DOM.
// Vancouver meters: enforced 9am–10pm. Free 10pm–9am.
// Two rate windows: 9am–6pm (540–1080 min), 6pm–10pm (1080–1320 min).

export const ENF_START = 540;   // 9:00am
export const MID = 1080;        // 6:00pm
export const ENF_END = 1320;    // 10:00pm

export function parseMoney(s) {
  if (!s) return null;
  const m = String(s).match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// "2 Hr" -> 120, "30 Min" -> 30, "No Time Limit" -> Infinity, null -> null
export function parseTimeLimit(s) {
  if (!s || s === 'None') return null;
  if (/no time limit/i.test(s)) return Infinity;
  let m = s.match(/([0-9]+)\s*hr/i);
  if (m) return parseInt(m[1]) * 60;
  m = s.match(/([0-9]+)\s*min/i);
  if (m) return parseInt(m[1]);
  return null;
}

// "3:00pm to 7:00pm" -> [900, 1140] minutes-from-midnight
export function parseRange(s) {
  if (!s || s === 'None') return null;
  const re = /([0-9]{1,2}):?([0-9]{2})?\s*(am|pm|noon)?\s*to\s*([0-9]{1,2}):?([0-9]{2})?\s*(am|pm|noon)?/i;
  const m = s.replace(/noon/gi, '12:00pm').match(re);
  if (!m) return null;
  const to = (h, min, ap) => {
    h = parseInt(h); min = min ? parseInt(min) : 0;
    ap = (ap || '').toLowerCase();
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + min;
  };
  return [to(m[1], m[2], m[3]), to(m[4], m[5], m[6])];
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Haversine distance in meters
export function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Cost of a stay [arrival, arrival+duration] in minutes-from-midnight.
export function costFor(arrival, duration, rate1, rate2, flat) {
  const end = arrival + duration;
  const h1 = overlap(arrival, end, ENF_START, MID) / 60;
  const h2 = overlap(arrival, end, MID, ENF_END) / 60;
  let metered = h1 * (rate1 || 0) + h2 * (rate2 || 0);
  // flat-rate option caps the cost when it's cheaper (usually an evening/day deal)
  if (flat != null && flat < metered) metered = flat;
  const meteredMin = overlap(arrival, end, ENF_START, ENF_END);
  const freeMin = duration - meteredMin;
  const freeAfter = end > ENF_END; // some of the stay spills past 10pm
  return { cost: Math.round(metered * 100) / 100, meteredMin, freeMin, freeAfter };
}

// Hourly rate in effect at a moment (minutes-from-midnight). rate1/rate2 pre-parsed.
export function rateNow(rate1, rate2, mins) {
  if (mins < ENF_START || mins >= ENF_END) return { rate: 0, free: true };
  if (mins < MID) return { rate: rate1 || 0, free: !rate1 };
  return { rate: rate2 || 0, free: !rate2 };
}

// Time limit in effect at a moment. Limits pre-parsed to minutes (null/Infinity allowed).
export function limitNow(limits, mins, weekend) {
  if (mins < ENF_START || mins >= ENF_END) return null; // unenforced — no limit
  const day = mins < MID;
  return weekend ? (day ? limits.wkndDay : limits.wkndEve) : (day ? limits.day : limits.eve);
}

// Is `mins` inside a parsed [start, end) range?
export function inRange(range, mins) {
  return range != null && mins >= range[0] && mins < range[1];
}

const WALK_M_PER_MIN = 80;      // ~4.8 km/h
const WALK_COST_PER_MIN = 0.30; // "balanced" mode: dollar-value of one minute of walking

// 8-point compass bearing FROM the destination TO the spot (which way you'll walk).
export function bearing(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  let deg = (Math.atan2(y, x) / rad + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// opts: {lat, lon, arrival, duration, maxWalkMin, weekend, sort}
// sort: 'balanced' (default) blends price + walk; 'cheap' is price-first.
export function rankMeters(meters, opts) {
  const { lat, lon, arrival, duration, maxWalkMin } = opts;
  const sort = opts.sort || 'balanced';
  const radius = maxWalkMin * WALK_M_PER_MIN;
  const inService = meters.filter((m) => m.service_status === 'In Service' && m.geo_point_2d);
  const out = [];

  for (const m of meters) {
    if (m.service_status !== 'In Service') continue;
    if (m.vehicle_type && m.vehicle_type !== 'Any Vehicle') continue;
    const g = m.geo_point_2d;
    if (!g) continue;

    const d = distMeters(lat, lon, g.lat, g.lon);
    if (d > radius) continue;

    // rush-hour tow-away: exclude if the stay overlaps it
    const end = arrival + duration;
    const rushes = [parseRange(m.am_rush_hours), parseRange(m.pm_rush_hours)].filter(Boolean);
    let towConflict = false;
    for (const [rs, re] of rushes) if (overlap(arrival, end, rs, re) > 0) towConflict = true;
    if (towConflict) continue;

    const rate1 = parseMoney(m.rate_9am_6pm);
    const rate2 = parseMoney(m.rate_6pm_10pm);
    const flat = parseMoney(m.flat_rate);
    const c = costFor(arrival, duration, rate1, rate2, flat);

    // time-limit risk during enforcement
    const limit = parseTimeLimit(opts.weekend ? m.time_limit_weekend_9am_6pm : m.time_limit_9am_6pm);
    const overLimit = limit != null && limit !== Infinity && c.meteredMin > limit;

    const walkMin = Math.round(d / WALK_M_PER_MIN);
    // block density: how many in-service meters share this stretch (higher = better odds one's open)
    let blockCount = 0;
    for (const n of inService) {
      if (distMeters(g.lat, g.lon, n.geo_point_2d.lat, n.geo_point_2d.lon) <= 40) blockCount++;
    }
    // human-readable rate note: show the 6pm rate drop when the stay straddles it
    const beforeSix = overlap(arrival, end, ENF_START, MID) > 0;
    const afterSix = overlap(arrival, end, MID, ENF_END) > 0;
    let rateNote;
    if (beforeSix && afterSix && rate1 != null && rate2 != null && rate1 !== rate2) {
      rateNote = `$${rate1.toFixed(2)}/hr, $${rate2.toFixed(2)} after 6 PM`;
    } else {
      const hr = arrival < MID ? rate1 : (arrival < ENF_END ? rate2 : 0);
      rateNote = hr ? `$${hr.toFixed(2)}/hr` : 'free right now';
    }

    out.push({
      rateNote,
      meter: m,
      lat: g.lat, lon: g.lon,
      distM: Math.round(d),
      walkMin,
      dir: bearing(lat, lon, g.lat, g.lon),
      cost: c.cost,
      free: c.cost === 0,
      freeMin: c.freeMin,
      freeAfter: c.freeAfter,
      rate1, rate2, flat,
      limit,
      overLimit,
      blockCount,
      // balanced score: money plus the dollar-value of the walk (lower = better)
      score: c.cost + walkMin * WALK_COST_PER_MIN,
      hourlyNow: arrival < MID ? rate1 : (arrival < ENF_END ? rate2 : 0),
    });
  }

  // over-limit always sinks. then by chosen sort key, walk breaks ties.
  out.sort((a, b) => {
    if (a.overLimit !== b.overLimit) return a.overLimit ? 1 : -1;
    const key = sort === 'cheap' ? 'cost' : 'score';
    if (a[key] !== b[key]) return a[key] - b[key];
    return a.walkMin - b.walkMin;
  });
  return out;
}

export function minsToLabel(mins) {
  let h = Math.floor(mins / 60) % 24, m = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}
