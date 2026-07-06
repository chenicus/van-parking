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
  let watchId = null, active = false, follow = true, lock = null, lastPos = null, resumeTimer = null;

  const chev = L.marker([0, 0], {
    icon: L.divIcon({ className: '', html: '<div class="chevwrap"><div class="chev"></div></div>', iconSize: [0, 0] }),
    zIndexOffset: 3000, interactive: false, keyboard: false,
  });

  function setFollow(v) {
    if (follow === v) return;
    follow = v;
    clearTimeout(resumeTimer);
    if (!v && active) resumeTimer = setTimeout(() => setFollow(true), 15000);
    if (v && lastPos) map.setView([lastPos.lat, lastPos.lon], Math.max(map.getZoom(), 16));
    onFollowChange(v);
  }

  function onDrag() { if (active) setFollow(false); }

  function accept(p) {
    const { latitude: lat, longitude: lon, accuracy, heading, speed } = p.coords;
    if (accuracy != null && accuracy > 50) return;       // jitter gate
    if (lastPos && distMeters(lastPos.lat, lastPos.lon, lat, lon) < 3) return;
    let hdg = (speed != null && speed > 2 && heading != null && isFinite(heading)) ? heading : null;
    if (hdg == null && lastPos) hdg = bearingDeg(lastPos.lat, lastPos.lon, lat, lon);
    lastPos = { lat, lon, hdg: hdg != null ? hdg : (lastPos ? lastPos.hdg : 0) };
    chev.setLatLng([lat, lon]);
    const el = chev.getElement()?.querySelector('.chev');
    if (el) el.style.transform = `rotate(${lastPos.hdg}deg)`;
    if (follow) map.setView([lat, lon], Math.max(map.getZoom(), 16), { animate: true, duration: 0.9 });
    onFix(lastPos);
  }

  async function acquireLock() {
    try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (active && document.visibilityState === 'visible') acquireLock();
  });

  return {
    isActive: () => active,
    isFollowing: () => follow,
    lastPos: () => lastPos,
    setFollow,
    setSimTrack: (t) => geo.setTrack?.(t),
    start() {
      if (active || !geo) return;
      active = true; follow = true; lastPos = null;
      chev.setLatLng([49.2606, -123.114]).addTo(map);
      watchId = geo.watchPosition(accept, () => {}, {
        enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
      });
      map.on('dragstart', onDrag);
      acquireLock();
      if (!('wakeLock' in navigator) && !params.get('sim')) onActiveChange('nolock');
      else onActiveChange(true);
    },
    stop() {
      if (!active) return;
      active = false;
      geo.clearWatch(watchId);
      map.off('dragstart', onDrag);
      map.removeLayer(chev);
      clearTimeout(resumeTimer);
      lock?.release?.(); lock = null;
      onActiveChange(false);
    },
  };
}
