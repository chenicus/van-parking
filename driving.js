// Driving mode: live follow-me tracking, car chevron, wake lock, GPS simulator.
// Routing lives in nav.js — this module only produces fixes and follows them.
// MapLibre renders/eases the map on the GPU, so following is a single easeTo per fix
// (center + heading-up bearing) — no hand-rolled sub-pixel glide or dead-reckoning.
import { distMeters } from './rank.js?v=15';

function bearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// ---- GPS simulator (?sim=1): plays a downtown track at ~12 m/s with jitter ----
const SIM_TRACK = [   // up Howe St, left onto Robson toward Burrard
  [49.2740, -123.1295], [49.2762, -123.1268], [49.2784, -123.1242],
  [49.2806, -123.1215], [49.2823, -123.1196], [49.2836, -123.1240],
  [49.2846, -123.1266], [49.2856, -123.1292],
];
export const SIM_START = { lat: SIM_TRACK[0][0], lon: SIM_TRACK[0][1] };
function makeSimGeo(speed = 12) {
  let timer = null, track = SIM_TRACK, seg = 0, prog = 0;
  return {
    // nav mode swaps in the route geometry so the sim car drives the route
    setTrack(t) { if (t && t.length > 1) { track = t; seg = 0; prog = 0; } },
    watchPosition(cb) {
      let tick = 0;
      timer = setInterval(() => {
        tick++;
        let [aLat, aLon] = track[seg];
        let [bLat, bLon] = track[seg + 1];
        let segLen = distMeters(aLat, aLon, bLat, bLon);
        prog += speed;
        while ((prog > segLen || segLen === 0) && seg < track.length - 2) {
          prog -= segLen; seg++;
          [aLat, aLon] = track[seg]; [bLat, bLon] = track[seg + 1];
          segLen = distMeters(aLat, aLon, bLat, bLon);
        }
        const f = segLen ? Math.min(prog / segLen, 1) : 1;
        const jit = () => (Math.random() - 0.5) * 2 * 0.00004; // ~±4 m
        cb({
          coords: {
            latitude: aLat + (bLat - aLat) * f + jit(),
            longitude: aLon + (bLon - aLon) * f + jit(),
            accuracy: tick % 12 === 0 ? 80 : 8,   // periodic bad fix exercises the gate
            heading: bearingDeg(aLat, aLon, bLat, bLon),
            speed,
          },
          timestamp: Date.now(),
        });
      }, 1000);
      return 1;
    },
    clearWatch() { clearInterval(timer); timer = null; },
  };
}

// `bearing` is a callback from app.js returning the desired map bearing for the current mode
// (heading-up POV → the car heading; north-up → 0).
export function createDriving({ map, onFix, onActiveChange, onFollowChange, bearing, resolveDisplay }) {
  const params = new URLSearchParams(location.search);
  const geo = params.get('sim') ? makeSimGeo() : navigator.geolocation;
  let watchId = null, active = false, follow = true, lock = null, lastPos = null, hiAcc = false;
  // Where the car is DRAWN (and the camera follows). Usually the raw fix, but during nav it's the
  // fix snapped onto the route (resolveDisplay), so the puck rides the street, not the buildings.
  // lastPos stays raw — heading, off-route and arrival logic all reason about the true fix.
  let lastDisp = null;
  const displayOf = (p) => (resolveDisplay && p ? (resolveDisplay(p) || p) : p);
  let zooming = false;      // a pinch/wheel zoom is in flight — pause re-centering, don't fight it
  let chevAdded = false;
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wantBearing = () => (bearing ? bearing() : 0);

  // Car chevron: a MapLibre HTML marker. rotationAlignment:'map' + setRotation(heading) points it
  // along the true heading, so it reads screen-up in heading-up mode and along-heading when north-up.
  const chevEl = document.createElement('div');
  chevEl.innerHTML = '<div class="chevwrap"><div class="chev"></div></div>';
  const chev = new maplibregl.Marker({ element: chevEl, rotationAlignment: 'map', pitchAlignment: 'map' });

  // Ease the map onto the car (and to the mode's bearing). MapLibre interpolates center + bearing
  // continuously on the GPU, so a linear ease over ~the fix interval gives a smooth glide.
  function followTo(dur = 900) {
    if (!follow || zooming || !lastDisp) return;
    map.easeTo({ center: [lastDisp.lon, lastDisp.lat], bearing: wantBearing(),
      duration: reduce() ? 0 : dur, easing: (t) => t });
  }

  function setFollow(v) {
    if (follow === v) return;
    follow = v;
    // No auto-resume: once you pan away, the map stays put until you tap recenter / "my location".
    if (v && lastDisp) map.easeTo({ center: [lastDisp.lon, lastDisp.lat], zoom: Math.max(map.getZoom(), 16),
      bearing: wantBearing(), duration: reduce() ? 0 : 500 });
    onFollowChange(v);
  }

  function onDrag() { if (active) setFollow(false); }
  // Zooming (pinch/wheel) keeps follow ON but the ease must pause so we don't cancel MapLibre's
  // own zoom animation; snap the car back to center when it ends.
  function onZoomStart() { zooming = true; }
  function onZoomEnd() { zooming = false; if (active && follow) followTo(300); }

  function accept(p) {
    const { latitude: lat, longitude: lon, accuracy, heading, speed } = p.coords;
    if (accuracy != null && accuracy > 50) return;       // drop wild fixes
    const moved = lastPos ? distMeters(lastPos.lat, lastPos.lon, lat, lon) : Infinity;
    if (moved < 3) return;                               // holding station — ignore GPS jitter

    // Heading, most-trusted first. The old code inferred a bearing from ANY >3 m step, so a
    // slow crawl or a jittery downtown fix (accuracy up to 50 m, GPS bounces off buildings)
    // would point the map — and the compass needle riding on it — in a random direction. That
    // was the "compass keeps spinning / won't show my direction" bug. Now:
    //   1) trust the device's own heading while genuinely moving, and only if it's a real value
    //      — some phones report -1 for "unknown", which isFinite() alone would let through;
    //   2) else infer from the step, but only on a long, accurate move — not GPS scatter;
    //   3) else keep the last good heading and never snap to a guess.
    let hdg;
    if (speed != null && speed > 2 && heading != null && isFinite(heading) && heading >= 0) {
      hdg = heading;                                   // moving fast enough to trust the device heading
    } else if (speed != null && speed < 1) {
      hdg = lastPos ? lastPos.hdg : 0;                 // essentially stopped — hold, don't chase position jitter
    } else if (lastPos && moved >= 10 && (accuracy == null || accuracy <= 25)) {
      hdg = bearingDeg(lastPos.lat, lastPos.lon, lat, lon);   // no device heading — infer from a real, accurate step
    } else {
      hdg = lastPos ? lastPos.hdg : 0;                 // not enough signal — keep the last good heading
    }
    lastPos = { lat, lon, hdg };
    lastDisp = displayOf(lastPos);   // raw fix, or its on-route snap during nav
    // Draw the car at the display point. Marker stays screen-upright (rotationAlignment handles
    // heading); its rotation is the geographic heading so it points the right way in both orientations.
    chev.setLngLat([lastDisp.lon, lastDisp.lat]).setRotation(hdg);
    if (!chevAdded) { chev.addTo(map); chevAdded = true; }
    followTo();
    onFix(lastPos);
  }

  async function acquireLock() {
    try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    // Only nav (hi-accuracy) holds the screen awake — re-grab it on return.
    if (active && hiAcc && document.visibilityState === 'visible') acquireLock();
  });

  return {
    isActive: () => active,
    isFollowing: () => follow,
    lastPos: () => lastPos,
    // Re-point to the mode's bearing (and recenter if following) — called on compass toggle /
    // drive start. Distinct from recenter(): it never changes zoom.
    reorient() {
      if (!active) return;
      if (follow && lastDisp) map.easeTo({ center: [lastDisp.lon, lastDisp.lat], bearing: wantBearing(),
        duration: reduce() ? 0 : 500 });
      else map.easeTo({ bearing: wantBearing(), duration: reduce() ? 0 : 500 });
    },
    // Snap the map back onto the car (used by the recenter fab / "my location").
    recenter: () => { if (follow && lastDisp) map.easeTo({ center: [lastDisp.lon, lastDisp.lat],
      zoom: Math.max(map.getZoom(), 16), bearing: wantBearing(), duration: reduce() ? 0 : 400 }); },
    setFollow,
    setSimTrack: (t) => geo.setTrack?.(t),
    // Two-tier location, mirroring Google Maps. BOTH tiers use live GPS (enableHighAccuracy +
    // fresh fixes) so the puck actually follows you while driving — the tiers differ ONLY in the
    // screen wake lock, which is the real battery cost:
    //   passive (default on open) — live GPS, but no wake lock, so the screen still sleeps.
    //   nav (setNavMode(true))    — live GPS + a screen wake lock held while routing.
    // (Passive used to request coarse network location with 30 s-stale fixes; downtown that reads
    // worse than the 50 m accept gate, so the dot froze — "I'm driving but it doesn't move".)
    start({ passive = false } = {}) {
      if (active || !geo) return;
      active = true; follow = true; lastPos = null; lastDisp = null; hiAcc = !passive;
      // Instant "blue dot": snap to a cached fix while the live watch warms up.
      geo.getCurrentPosition?.(accept, () => {}, { enableHighAccuracy: false, maximumAge: 600000, timeout: 8000 });
      watchId = geo.watchPosition(accept, () => {}, {
        enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
      });
      map.on('dragstart', onDrag);
      map.on('zoomstart', onZoomStart);
      map.on('zoomend', onZoomEnd);
      if (!passive) acquireLock();   // passive follow stays battery-cheap — no lock
      if (!passive && !('wakeLock' in navigator) && !params.get('sim')) onActiveChange('nolock');
      else onActiveChange(true);
    },
    // Flip between passive and nav tiers without dropping the session (re-watch + lock).
    setNavMode(on) {
      if (!active || hiAcc === on) return;
      hiAcc = on;
      geo.clearWatch(watchId);
      watchId = geo.watchPosition(accept, () => {}, {
        enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,   // tiers differ by wake lock, not GPS
      });
      if (on) acquireLock();
      else { lock?.release?.(); lock = null; }
    },
    stop() {
      if (!active) return;
      active = false;
      geo.clearWatch(watchId);
      zooming = false;
      map.off('dragstart', onDrag);
      map.off('zoomstart', onZoomStart);
      map.off('zoomend', onZoomEnd);
      if (chevAdded) { chev.remove(); chevAdded = false; }
      lock?.release?.(); lock = null;
      onActiveChange(false);
    },
  };
}
