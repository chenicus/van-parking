<div align="center">

# 🚗 Park Daddy

**Live street-parking rates for Vancouver, Seattle & San Francisco — see prices update as you drive.**

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
| 🧭 **Drive mode** | Follow-me map showing each block's parking rate as you drive past it. |
| 🅿️ **Up-to-date meter data** | Every metered block across Vancouver, Seattle & San Francisco, refreshable per city. |
| 🚫 **No-park awareness** | Loading zones, no-stopping and permit-only windows hide the spot while active and show in its schedule. |
| ⚠️ **Crowd-sourced spot reports** | Drivers flag wrong spots (sign changed, permit-only, etc.); 1 report warns the pill, 3 hide it. |

---

## 🛠️ Tools & APIs

| Layer | What we use | For |
|---|---|---|
| **Map** | [MapLibre GL 4.7](https://maplibre.org/) + [CARTO vector styles](https://carto.com/basemaps/) | Rotatable vector map + light/dark styles (CDN). |
| **Parking data** | [City of Vancouver](https://opendata.vancouver.ca/), [Seattle](https://data.seattle.gov/) & [San Francisco](https://datasf.org/) open data | Meter rates, limits, rush-hours, prohibition zones, geo. |
| **Routing** | [Valhalla](https://valhalla1.openstreetmap.de/) (public OSM server) | Drive-mode route geometry + maneuvers. |
| **Geocoding** | [Nominatim (OpenStreetMap)](https://nominatim.org/) | Address / place / street search + autocomplete. |
| **Fallback nav** | [Google Maps deep links](https://developers.google.com/maps/documentation/urls/get-started) | Hand off to native turn-by-turn. |
| **Backend** | [Supabase](https://supabase.com/) (Postgres + Storage, via REST from plain `fetch`) | Stores crowd reports + sign photos; RLS-guarded, no SDK. |
| **Browser APIs** | Geolocation, Wake Lock | Follow-me GPS, keep-screen-awake. |
| **Hosting** | GitHub Pages (static frontend) + Supabase (data) | Zero-build static site talking to a hosted backend. |

> **Stack:** plain HTML + vanilla ES modules. No framework, no bundler, no build step.

---

## 📍 Coverage: Vancouver, Seattle & San Francisco

Park Daddy covers three cities that publish open parking data: the **City of Vancouver**
(`parking-meters` + `parking-tickets`), **Seattle** (paid blockfaces), and **San Francisco**
(metered blocks with time-of-day rate bands). The map auto-loads the city you're in or pan to.

Coverage is gated by open data, not ambition. Cities that run metered parking on a closed
platform (e.g. PayByPhone, with no equivalent open dataset) would require scraping rather than
a clean data download, so they're out of scope for now. Around Vancouver that rules out
neighbours like **Burnaby**, **New Westminster** and **North Vancouver**, whose portals expose
parks and streets but not meter rates or locations.
