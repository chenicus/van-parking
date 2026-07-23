#!/usr/bin/env python3
# Build San Francisco's free-parking layer — the SF twin of build-seattle.py's build_free().
#
# Seattle hands us a blockface table with a PARKING_CATEGORY per side of street, and we
# keep the two categories that cost nothing (Unrestricted, Time Limited). SF has the same
# shape in DataSF "Parking regulations (except non-metered color curb)" (hi6h-neyh): one
# polyline per regulated blockface, with a `regulation` column. So we keep the one
# regulation that means free-but-capped — "Time limited" — and drop the rest (RPP-only,
# government permit, no-parking, no-oversized, pay-or-permit).
#
# ONE ASYMMETRY vs Seattle, and it's the important one: this table lists only REGULATED
# blockfaces. There is no "Unrestricted Parking" row, so SF's free layer is time-limited
# blocks ONLY — a street with no sign at all is free-and-unlimited but simply isn't in any
# SF dataset, so we can't draw it. That's a coverage gap, not a bug; better to show fewer
# true free blocks than to invent them (same reasoning as build-sf.py's Sunday rates).
#
# The limit we emit is the posted cap and we apply it around the clock, even though the
# rows carry a window (e.g. "2 hr, M-F 9am-6pm" — free and UNLIMITED outside it). That
# errs strict: we may tell you to move when you didn't have to. The opposite error sends
# you back to a ticket, so until the app can render a windowed cap, strict it is.
#
# Source: https://data.sfgov.org/d/hi6h-neyh   (Socrata, no key, ~7.8k rows)
import json, math, urllib.parse, urllib.request

from sf_towaway import TowMatcher, fetch_towaway

REGS = "https://data.sfgov.org/resource/hi6h-neyh.json"
METERS = "https://data.sfgov.org/resource/8vzz-qzz9.json"
UA = {"User-Agent": "park-daddy/1.0 (hey.cchen@gmail.com)"}
PAGE = 5000

# `regulation` is free text and its casing has drifted across a decade of MTA Board edits
# ("Time limited" / "Time Limited" / "Time LImited"), so match on the lowered string.
KEEP = "time limited"

# SF's own parking census assumes 17 ft per undemarcated space; the regulation rows carry
# a blockface length but no space count, so we reuse that constant to estimate one.
FT_PER_SPACE = 17

# A time-limited blockface that sits on top of meters is really a metered block whose cap
# is already in sf-meters.json — drawing it blue would read as "free" over paid asphalt.
# Drop any face with a meter this close (m) to its geometry.
METER_NEAR_M = 18


def fetch(url, params):
    rows, offset = [], 0
    while True:
        q = dict(params, **{"$limit": PAGE, "$offset": offset})
        req = urllib.request.Request(url + "?" + urllib.parse.urlencode(q), headers=UA)
        with urllib.request.urlopen(req, timeout=180) as r:
            page = json.load(r)
        rows.extend(page)
        print(f"  fetched {len(rows)} …")
        if len(page) < PAGE:
            return rows
        offset += PAGE


def coords_of(row):
    """Blockface polyline as [[lon,lat], …]. Rows are MultiLineString; in practice one part."""
    g = row.get("shape")
    if not g or not g.get("coordinates"):
        return None
    parts = g["coordinates"]
    if not parts or not parts[0]:
        return None
    return [[round(x, 6), round(y, 6)] for x, y in parts[0]]


def midpoint(coords):
    """Point at half the polyline's arc length — where the pill sits. (Same as Seattle's.)"""
    if len(coords) == 1:
        return coords[0]
    segs, total = [], 0.0
    for a, b in zip(coords, coords[1:]):
        d = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        segs.append(d)
        total += d
    half, run = total / 2, 0.0
    for (a, b), d in zip(zip(coords, coords[1:]), segs):
        if run + d >= half:
            t = 0 if d == 0 else (half - run) / d
            return [round(a[0] + (b[0] - a[0]) * t, 6), round(a[1] + (b[1] - a[1]) * t, 6)]
        run += d
    return coords[-1]


def hblock(row):
    """These rows have no street name — only geometry and a supervisor/neighborhood tag.
    The neighborhood is the best human anchor we have for the card heading."""
    return (row.get("analysis_neighborhood") or "San Francisco").title()


def limit_min(row):
    """hrlimit is hours as a float string ('2', '0.5', '0.330000013') -> whole minutes."""
    try:
        m = round(float(row.get("hrlimit") or 0) * 60)
    except ValueError:
        return 0
    return m


# ── meter proximity ────────────────────────────────────────────────────────────────────
# Cheap equirectangular grid: at SF's latitude a degree of longitude is ~0.79 of a degree
# of latitude, so we can bucket meters into a lat/lon hash and compare in flat meters.
M_PER_DEG_LAT = 111_320
LAT0 = 37.77
LON_SCALE = math.cos(math.radians(LAT0))
CELL = 0.0005   # ~55 m


def meter_grid():
    print("Meters (to drop faces that are really metered)…")
    rows = fetch(METERS, {"$where": "on_offstreet_type='ON' AND active_meter_flag in('M','P')",
                          "$select": "latitude,longitude"})
    grid = {}
    for m in rows:
        try:
            la, lo = float(m["latitude"]), float(m["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        grid.setdefault((int(la / CELL), int(lo / CELL)), []).append((la, lo))
    return grid


def near_meter(grid, coords):
    for lon, lat in coords:
        ci, cj = int(lat / CELL), int(lon / CELL)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for (mla, mlo) in grid.get((ci + di, cj + dj), ()):
                    dy = (mla - lat) * M_PER_DEG_LAT
                    dx = (mlo - lon) * M_PER_DEG_LAT * LON_SCALE
                    if dx * dx + dy * dy <= METER_NEAR_M ** 2:
                        return True
    return False


def build_free():
    grid = meter_grid()

    print("Scheduled tow-away zones (ynvq-waab)…")
    tow = TowMatcher(fetch_towaway())

    print("Time-limited blockfaces…")
    rows = fetch(REGS, {"$select": "regulation,hrlimit,length_ft,analysis_neighborhood,shape"})

    out, metered, nolimit, towed = [], 0, 0, 0
    for row in rows:
        if (row.get("regulation") or "").strip().lower() != KEEP:
            continue
        coords = coords_of(row)
        if not coords:
            continue
        lim = limit_min(row)
        if not lim:            # a "time limited" row with no hours posted tells us nothing
            nolimit += 1
            continue
        if near_meter(grid, coords):
            metered += 1
            continue
        try:
            spaces = max(1, int(float(row.get("length_ft") or 0) // FT_PER_SPACE))
        except ValueError:
            spaces = 1
        proh = tow.match(coords)   # coords are already [lon, lat]
        if proh:
            towed += 1
        out.append({
            "h": hblock(row),
            "cat": "tl",       # every SF free block is time-limited (see header)
            "spaces": spaces,
            "limit": lim,      # minutes — free, but capped
            "line": coords,
            "mid": midpoint(coords),
            "proh": proh,      # scheduled tow-away windows on this curb face (usually [])
        })

    json.dump(out, open("data/sf-free.json", "w"), separators=(",", ":"))
    print(f"\nWrote {len(out)} free blockfaces -> data/sf-free.json"
          f"  (dropped {metered} metered, {nolimit} with no posted limit; {towed} carry a tow-away window)")


if __name__ == "__main__":
    print("Downloading SF parking-regulation data…")
    build_free()
