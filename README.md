<div align="center">

# 🚗 Park Daddy

**Live street-parking rates for Vancouver — see prices update as you drive.**

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
| 🅿️ **Up-to-date meter data** | Every Vancouver metered block (3,758 meters), refreshable with one script. |
| ⚠️ **Crowd-sourced spot reports** | Drivers flag wrong spots (sign changed, permit-only, etc.); 1 report warns the pill, 3 hide it. |

---

## 🛠️ Tools & APIs

| Layer | What we use | For |
|---|---|---|
| **Map** | [Leaflet 1.9.4](https://leafletjs.com/) + [CARTO basemaps](https://carto.com/basemaps/) | Map + light/dark tiles (CDN, SRI-pinned). |
| **Parking data** | [City of Vancouver Open Data](https://opendata.vancouver.ca/) — `parking-meters` + `parking-tickets` | Meter rates, limits, rush-hours, geo. |
| **Routing** | [Valhalla](https://valhalla1.openstreetmap.de/) (public OSM server) | Drive-mode route geometry + maneuvers. |
| **Geocoding** | [Nominatim (OpenStreetMap)](https://nominatim.org/) | Address / place / street search + autocomplete. |
| **Fallback nav** | [Google Maps deep links](https://developers.google.com/maps/documentation/urls/get-started) | Hand off to native turn-by-turn. |
| **Backend** | [Supabase](https://supabase.com/) (Postgres + Storage, via REST from plain `fetch`) | Stores crowd reports + sign photos; RLS-guarded, no SDK. |
| **Browser APIs** | Geolocation, Wake Lock | Follow-me GPS, keep-screen-awake. |
| **Hosting** | GitHub Pages (static frontend) + Supabase (data) | Zero-build static site talking to a hosted backend. |

> **Stack:** plain HTML + vanilla ES modules. No framework, no bundler, no build step.

---

## 📍 Coverage: Vancouver only

Park Daddy covers the **City of Vancouver only**, because it's the only municipality that
publishes the data. The app is built entirely on Vancouver's open `parking-meters` +
`parking-tickets` feeds.

Neighbouring cities — **Burnaby**, **New Westminster**, **North Vancouver**, etc. — run their
metered parking on PayByPhone but publish **no equivalent open dataset**. Their open-data
portals only expose things like parks, streets, and (for North Van District) parking
*restriction* lines — not meter rates or locations. Adding those cities would mean scraping
PayByPhone rather than a clean data download, so for now coverage stops at the Vancouver city
limits (Boundary Rd).
