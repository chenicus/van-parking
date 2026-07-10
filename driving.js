// Driving mode: live follow-me tracking, car chevron, wake lock, GPS simulator.
// Routing lives in nav.js — this module only produces fixes and follows them.
import { distMeters } from './rank.js?v=11';

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

export function createDriving({ map, onFix, onActiveChange, onFollowChange }) {
  const params = new URLSearchParams(location.search);
  const geo = params.get('sim') ? makeSimGeo() : navigator.geolocation;
  let watchId = null, active = false, follow = true, lock = null, lastPos = null, hiAcc = false;

  const chev = L.marker([0, 0], {
    icon: L.divIcon({ className: '', html: '<div class="chevwrap"><div class="chev"></div></div>', iconSize: [0, 0] }),
    zIndexOffset: 3000, interactive: false, keyboard: false,
  });

  // Sub-pixel follow. Leaflet re-rounds its tile origin and marker icons to whole pixels every
  // frame, so at low zoom (few px/sec) the map advances in visible 1px steps. We cancel that by
  // shifting the whole map wrapper by the fractional-pixel remainder via a GPU CSS transform, so
  // the scene glides between pixels. --pan-x/--pan-y feed body.follow #maprot's transform (see
  // index.html); they carry no CSS transition, so they update instantly each frame.
  const rotEl = document.getElementById('maprot');
  const setPan = (x, y) => {
    if (!rotEl) return;
    rotEl.style.setProperty('--pan-x', x.toFixed(2) + 'px');
    rotEl.style.setProperty('--pan-y', y.toFixed(2) + 'px');
  };

  // Smooth follow. Snapping the marker to each ~1s GPS fix pulses; easing toward the *static*
  // last fix decelerates to a stop before the next lands — jump, pause, jump. So we integrate a
  // displayed position from a smoothed velocity vector every frame (constant, continuous glide)
  // and correct toward the fixes without ever stepping the display:
  //   • velocity carries the motion — clean and continuous (raw fixes carry GPS position noise);
  //   • each fix only nudges a correction accumulator a fraction (ALPHA) toward the raw fix, so
  //     the noise low-passes out instead of snapping the whole map onto every fix;
  //   • render() bleeds that accumulator into the display gradually (over TC_CORR) rather than
  //     in one frame — an instant correction is the residual "slight shift", worst right after a
  //     dropped fix, so we spread it into an imperceptible drift.
  // MAX_COAST stops the dead-reckoning if fixes dry up; velocity is zeroed when stopped.
  const ALPHA = 0.2;        // fraction of each fix's position error folded into the correction
  const TC_CORR = 0.3;      // seconds to bleed a correction into the display — kills the per-fix step
  const MAX_COAST = 2;      // seconds of dead-reckoning before we stop trusting the last velocity
  let disp = null, rafId = null, lastFrame = 0, lastFixT = null;
  let vLat = 0, vLon = 0;   // velocity estimate (deg/s), smoothed across fixes
  let cLat = 0, cLon = 0;   // outstanding position correction, bled into disp over TC_CORR
  let zooming = false;      // a pinch/wheel zoom is in flight — pause re-centering, don't fight it

  function render(now) {
    rafId = null;
    if (disp == null) return;
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0;
    lastFrame = now;
    const coasting = lastFixT != null && (now - lastFixT) / 1000 < MAX_COAST;
    if (coasting) { disp.lat += vLat * dt; disp.lon += vLon * dt; }   // constant-velocity glide
    const bleed = dt > 0 ? 1 - Math.exp(-dt / TC_CORR) : 0;           // smoothly fold in the correction
    disp.lat += cLat * bleed; cLat -= cLat * bleed;
    disp.lon += cLon * bleed; cLon -= cLon * bleed;
    chev.setLatLng([disp.lat, disp.lon]);
    if (follow && !zooming) {
      // Center Leaflet on the car (it rounds its tile origin to whole pixels — crisp but stepped),
      // then read where the car actually lands ON SCREEN and shift the whole wrapper by the
      // leftover fraction so the scene glides between pixels. The comparison must be in
      // CONTAINER space (latLngToContainerPoint vs getSize()/2) — layer space is offset by the
      // map pane's own position, which re-anchors as you move and would turn the "sub-pixel"
      // nudge into whole-pixel jumps.
      // Respect the user's zoom here: flooring it (Math.max 16) per frame fights a zoom-out —
      // every frame cancels the gesture's animation and yanks back toward 16, which reads as
      // violent jitter below zoom 16. The "at least 16" floor lives only in the one-shot
      // engage points (setFollow / recenter). Likewise `zooming` pauses re-centering while a
      // pinch/wheel zoom is in flight so we never fight Leaflet's own zoom animation.
      map.setView([disp.lat, disp.lon], map.getZoom(), { animate: false });
      const c = map.getSize().divideBy(2);
      const cp = map.latLngToContainerPoint([disp.lat, disp.lon]);
      setPan(c.x - cp.x, c.y - cp.y);
      // Un-round the marker to its exact fractional point (Leaflet quantises marker icons too);
      // markers are positioned in LAYER space, hence latLngToLayerPoint here. With the wrapper
      // nudged by the same fraction, the car sits pinned dead-centre, shimmer-free.
      const cel = chev.getElement();
      if (cel) L.DomUtil.setPosition(cel, map.latLngToLayerPoint([disp.lat, disp.lon]));
    } else {
      setPan(0, 0);
    }
    // Keep animating while moving or while a correction is still settling; otherwise stop until
    // the next fix so we don't repaint at 60fps while idle.
    const settling = Math.abs(cLat) + Math.abs(cLon) > 1e-9;
    if (active && ((coasting && (vLat || vLon)) || settling)) rafId = requestAnimationFrame(render);
    else lastFrame = 0;
  }

  function setFollow(v) {
    if (follow === v) return;
    follow = v;
    // No auto-resume: once you pan away, the map stays put until you tap
    // recenter. Follow only turns back on via the recenter button.
    if (v && lastPos) map.setView([lastPos.lat, lastPos.lon], Math.max(map.getZoom(), 16));
    onFollowChange(v);
  }

  function onDrag() { if (active) setFollow(false); }

  // Zooming (pinch/wheel) keeps follow ON — it's a "how close" gesture, not a "look elsewhere"
  // one — but the render loop must not re-center mid-gesture: setView cancels Leaflet's zoom
  // animation each frame, which reads as violent jitter. Pause during the gesture, then snap
  // the car back to dead-center when it ends.
  function onZoomStart() { zooming = true; }
  function onZoomEnd() {
    zooming = false;
    if (active && follow && disp) map.setView([disp.lat, disp.lon], map.getZoom(), { animate: false });
  }

  function accept(p) {
    const { latitude: lat, longitude: lon, accuracy, heading, speed } = p.coords;
    if (accuracy != null && accuracy > 50) return;       // jitter gate
    if (lastPos && distMeters(lastPos.lat, lastPos.lon, lat, lon) < 3) return;
    const nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let hdg = (speed != null && speed > 2 && heading != null && isFinite(heading)) ? heading : null;
    if (hdg == null && lastPos) hdg = bearingDeg(lastPos.lat, lastPos.lon, lat, lon);
    hdg = hdg != null ? hdg : (lastPos ? lastPos.hdg : 0);
    // Velocity that drives the between-fix glide. Prefer the reported speed; fall back to the
    // fix-to-fix delta. Zero it when essentially stopped so the dot holds instead of drifting.
    let spd = (speed != null && isFinite(speed) && speed >= 0) ? speed : null;
    if (spd == null && lastPos && lastFixT != null) {
      spd = distMeters(lastPos.lat, lastPos.lon, lat, lon) / Math.max((nowT - lastFixT) / 1000, 1e-3);
    }
    if (spd != null && spd > 0.7) {
      const r = Math.PI / 180;
      const iVLat = (spd * Math.cos(hdg * r)) / 111320;
      const iVLon = (spd * Math.sin(hdg * r)) / (111320 * Math.cos(lat * r));
      if (!lastFixT) { vLat = iVLat; vLon = iVLon; }                          // first: adopt outright
      else { vLat += (iVLat - vLat) * 0.5; vLon += (iVLon - vLon) * 0.5; }    // smooth turns/noise
    } else { vLat = vLon = 0; }
    lastPos = { lat, lon, hdg };
    // Fold a fraction of the fix's position error into the correction accumulator; render()
    // bleeds it into the display over TC_CORR. Low-passes GPS noise AND avoids a per-fix step —
    // the glide itself rides the clean velocity above. (disp + c) is our current best estimate.
    if (disp == null) { disp = { lat, lon }; cLat = cLon = 0; }               // first fix: snap
    else {
      cLat += (lat - (disp.lat + cLat)) * ALPHA;
      cLon += (lon - (disp.lon + cLon)) * ALPHA;
    }
    lastFixT = nowT;
    // The marker stays visually upright regardless of heading or map POV — its only
    // rotation is a CSS counter-rotation of --map-rot (see .chev in index.html).
    if (!rafId) { lastFrame = 0; rafId = requestAnimationFrame(render); }
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
    // Snap the map back onto the marker's *displayed* (smoothed) position — the point the
    // follow loop actually centers on. Use this after a layout change (e.g. compass toggle)
    // so the car lands dead-center; centering on the raw lastPos instead would leave it
    // offset by the glide gap between the latest fix and where the marker is drawn.
    recenter: () => { if (follow && disp) map.setView([disp.lat, disp.lon], Math.max(map.getZoom(), 16), { animate: false }); },
    setFollow,
    setSimTrack: (t) => geo.setTrack?.(t),
    // Two-tier location, mirroring Google Maps:
    //   passive (default on open) — coarse/low-power fix, no wake lock, screen sleeps.
    //   nav (setNavMode(true))    — high-accuracy GPS + a screen wake lock while routing.
    start({ passive = false } = {}) {
      if (active || !geo) return;
      active = true; follow = true; lastPos = null; hiAcc = !passive;
      chev.setLatLng([49.2606, -123.114]).addTo(map);
      // Instant "blue dot": snap to a cached fix while the live watch warms up.
      geo.getCurrentPosition?.(accept, () => {}, { enableHighAccuracy: false, maximumAge: 600000, timeout: 8000 });
      watchId = geo.watchPosition(accept, () => {}, {
        enableHighAccuracy: hiAcc, maximumAge: passive ? 30000 : 1000, timeout: 20000,
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
        enableHighAccuracy: on, maximumAge: on ? 1000 : 30000, timeout: 20000,
      });
      if (on) acquireLock();
      else { lock?.release?.(); lock = null; }
    },
    stop() {
      if (!active) return;
      active = false;
      geo.clearWatch(watchId);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null; disp = null; lastFixT = null; vLat = vLon = 0; cLat = cLon = 0; lastFrame = 0;
      zooming = false;
      setPan(0, 0);   // drop the sub-pixel nudge so the wrapper sits neutral when idle
      map.off('dragstart', onDrag);
      map.off('zoomstart', onZoomStart);
      map.off('zoomend', onZoomEnd);
      map.removeLayer(chev);
      lock?.release?.(); lock = null;
      onActiveChange(false);
    },
  };
}
