<div align="center">

# 🚗 Park Daddy

**Find the cheapest street parking in Vancouver — ranked by price, then walk distance.**

Search a destination, get numbered spots on a map with live pricing, and drive there with
in-app turn-by-turn navigation. No app store, no build step, no API keys.

[**▶ Live app**](https://chenicus.github.io/park-daddy/)

![Zero build](https://img.shields.io/badge/build-none-brightgreen)
![Vanilla JS](https://img.shields.io/badge/js-vanilla%20ES%20modules-f7df1e)
![Data](https://img.shields.io/badge/data-City%20of%20Vancouver%20Open%20Data-blue)
![Hosting](https://img.shields.io/badge/hosting-GitHub%20Pages-181717)

</div>

---

## ✨ Features

| | |
|---|---|
| 🔎 **Smart search** | Type an address, place name, or street — geocoded on the fly. |
| 💸 **Cheapest-first ranking** | Costs your whole stay across rate windows, sorts free → cheapest → closest. |
| 🌙 **"Free after 10 PM"** | Meters stop at 10 PM — evening stays only pay the pre-10pm portion and get tagged. |
| 🅿️ **Free-parking blocks** | 2,413 unmetered 3-hour residential blocks, derived from real ticket data. |
| 🧾 **Clear pricing** | Shows the total for your stay *plus* the rate schedule (e.g. `$2/hr, $1.50 after 6 PM`). |
| 🎚️ **Park + Walk sliders** | Tune stay length and how far you'll walk; results re-rank live. |
| 📍 **Numbered pins ↔ list** | Price-pill markers tied to a draggable, peek/expand bottom sheet. |
| 🧭 **In-app turn-by-turn** | Tap a spot → **Start** → follow-me driving mode with a car chevron and voice-style banners. |
| 🕑 **Recent destinations** | Your last searches, one tap away. |
| 🔗 **Shareable links** | Search state lives in the URL — send someone a pre-filled search. |
| 🌗 **Auto light/dark** | iOS-style UI that follows the system theme. |

---

## 🛠️ Tools & APIs

| Layer | What we use | Why |
|---|---|---|
| **Map** | [Leaflet 1.9.4](https://leafletjs.com/) + [CARTO basemaps](https://carto.com/basemaps/) | Lightweight map with light/dark tiles. Loaded from CDN with SRI. |
| **Parking data** | [City of Vancouver Open Data](https://opendata.vancouver.ca/) — `parking-meters` + `parking-tickets` | Per-meter rates, limits, rush-hours, geo (3,758 meters). Tickets ground-truth the free blocks. |
| **Geocoding** | [Nominatim (OpenStreetMap)](https://nominatim.org/) | Free address / place / street lookup. |
| **Routing** | [Valhalla](https://valhalla1.openstreetmap.de/) (public OSM server) | Turn-by-turn geometry + ready-made English maneuvers. |
| **Fallback nav** | [Google Maps deep links](https://developers.google.com/maps/documentation/urls/get-started) | `dir/?api=1&destination=…` opens native turn-by-turn. |
| **Browser APIs** | Geolocation, Wake Lock, `localStorage`, URL state | Follow-me GPS, keep-screen-awake, recents, shareable searches. |
| **Build scripts** | Python 3 (`refresh.sh`, `build-free.py`) | Weekly data refresh + deriving free blocks from ticket data. |
| **Hosting** | GitHub Pages | Static files, zero backend. |

> **Stack:** plain HTML + vanilla ES modules. No framework, no bundler, no keys.

---

## 🚀 Run locally

```bash
# from ~/Projects
python3 -m http.server 3450 --directory Parking
```

Then open <http://localhost:3450> (or use the `park-daddy` preview config).

Append `?sim=1` to the URL to replay a downtown GPS track and test driving mode without moving.

---

## 🧠 How it works

- **Scoring** (`rank.js`) — filters to in-service, any-vehicle meters inside the walk radius
  (walk ≈ 80 m/min), excludes rush-hour tow-away conflicts, costs the stay across rate
  windows, picks the flat-rate option when it's cheaper, and sinks over-limit spots.
- **Free blocks** (`build-free.py`) — Vancouver has no "free parking" dataset, so we infer it:
  a *"MORE THAN 3 HRS"* ticket can only be issued on a free-3h street, so those blocks are
  ground-truth free. We join them to street geometry and drop any block that also shows
  permit-zone tickets.
- **Navigation** (`nav.js`, `driving.js`) — Valhalla returns route geometry + maneuvers;
  GPS fixes drive a follow-me map with current step, ETA, off-route detection, and arrival.

### Refresh the data
```bash
./refresh.sh          # re-download the latest meters dataset (updates weekly)
python3 build-free.py # rebuild free-parking blocks from ticket data
```

---

## 📌 Not included (v1)

- **Parkades** — the dataset is street meters only (usually the cheaper option anyway).
- **Cross-street intersections** — Nominatim can't resolve `"A & B"`; we fall back to street A.
- **Native CarPlay** — planned for phase 2.

---

## 🗺️ Roadmap / ideas

- **Ticket-risk note (phase 1.5)** — score each 100-block from the `parking-tickets` dataset and
  show a *small, quiet* inline note (secondary text, tiny amber icon, no chip/fill) only on
  **medium/high-risk** blocks, e.g. "Ticketed often here". Low-risk blocks show nothing — the
  point of the app is legal parking, so the warning stays subtle and doesn't compete with the
  spot info. Note: ticket data is **date-only (no hour)** and aggregated to the 100-block level,
  so risk is per-block, *not* per-time-of-day — don't imply hourly precision we don't have.
- **"Often full" / occupancy — deferred, do NOT fake it.** Vancouver publishes **no** real-time
  occupancy or meter-transaction feed, so any "usually full" label today would be a guess.
  Faking it sends drivers to non-existent spots and burns the trust the ticket note earns.
  The honest path: once there are users, **log every `Start → arrived` (and "couldn't park here")
  event** — that's real, first-party occupancy we own. Only surface "N of the last M found parking
  here" once the volume is there. Until then, occupancy stays out.
