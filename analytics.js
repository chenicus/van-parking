// Product analytics — PostHog, loaded lazily and only when config.js has a key.
//
// Why this wrapper exists: the app should behave identically with analytics off, so
// every export here degrades to a no-op when POSTHOG_KEY is blank (local dev, forks,
// anyone who doesn't want it). Nothing in the app should ever branch on "is analytics
// on" — just call track() and forget about it.
//
// What we deliberately DON'T send:
//   - the destination people type (it's a real address — often their home or work)
//   - GPS coordinates, ever
//   - anything from the report/feedback free-text fields
// Searches are logged as "a search happened, N results" — never the query itself. The one
// exception is a search that lands outside our cities: that logs the geocoder's town and
// country ("Portland, United States") because it's the demand signal for where to expand.
// Still coarse, still not the typed address, and disclosed in the privacy policy.
// If you add an event, keep to that line: shape of the interaction, not its content.
import { POSTHOG_KEY, POSTHOG_HOST } from './config.js?v=2';

const on = !!POSTHOG_KEY;
let ready = false;

// Our own pending queue rather than PostHog's official inline stub. The stub works by
// installing a placeholder `window.posthog` array that array.js later swaps out — which
// means anything holding a reference to the placeholder ends up writing into an object
// nothing will ever flush. Owning the queue here sidesteps that entirely: we only ever
// touch `window.posthog` after init, and always by fresh lookup.
let queue = [];
const QUEUE_MAX = 50;   // boot-time burst only; if array.js never lands, drop rather than grow

function init() {
  const s = document.createElement('script');
  s.async = true;
  s.src = POSTHOG_HOST + '/static/array.js';
  s.onload = () => {
    try {
      window.posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        // City-level geo is derived server-side from the request IP and the raw IP is
        // then discarded — we never store or see it. This is the flag that guarantees it.
        ip: false,
        // Autocapture logs every click/tap with its element, so we get "what do people
        // press" without instrumenting all 40 buttons. Named events cover the state
        // changes a click alone can't explain.
        autocapture: true,
        capture_pageview: true,
        // Session replay stays off: this app renders a map of where you are and a search
        // box you type addresses into. Replaying that is far more personal than counts.
        disable_session_recording: true,
        // Honor the browser's Do Not Track / Global Privacy Control signal.
        respect_dnt: true,
      });
      ready = true;
      for (const [e, p] of queue) send(e, p);
    } catch (err) {
      console.warn('[analytics] init failed', err);
    }
    queue = [];
  };
  // Blocked by an ad blocker, offline, DNS-nulled: all land here. Drop the backlog and
  // stay quiet — a missing analytics script is not something the driver needs to know.
  s.onerror = () => { queue = []; };
  document.head.appendChild(s);
}

function send(event, props) {
  try { window.posthog.capture(event, props); }
  catch { /* analytics must never break the app */ }
}

if (on) init();

/**
 * Log a product event. Props must be aggregate-safe — counts, enums, booleans and
 * city keys, never free text a user typed. No-ops entirely when analytics is off.
 */
export function track(event, props) {
  if (!on) return;
  if (ready) send(event, props || {});
  else if (queue.length < QUEUE_MAX) queue.push([event, props || {}]);
}
