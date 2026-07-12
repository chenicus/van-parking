#!/usr/bin/env python3
# Build San Francisco's paid-parking layer.
#
# SF is a HYBRID of the two shapes Park Daddy already handles:
#   • locations are POINT meters (like Vancouver) — we draw dots + one pill per block
#   • pricing is TIME-OF-DAY BANDS (like Seattle) — SF runs demand-responsive pricing,
#     so a block's hourly rate changes across the day and differs weekday/weekend.
# So an SF "block" carries meter points (for dots) AND rate bands (for pricing); on the
# app side buildSFBlocks reuses Seattle's band machinery (bandRateNow / seattleDaySegments)
# while rendering dots like Vancouver.
#
# Two sources, joined on street + hundred-block:
#   1. DataSF "Parking Meters" (8vzz-qzz9) — meter points, fresh weekly. Socrata, no key.
#   2. SFMTA quarterly "meter rate adjustments" CSV — the ONLY current per-block rate feed.
#      DataSF's own Meter-Rate-Schedules dataset is frozen at 2014, so we do NOT use it.
#      Download the latest CSV from https://www.sfmta.com/notices/citywide-meter-rate-adjustments
#      and point RATE_CSV at it. Rates change quarterly — re-download + re-run each quarter.
#
# Operating hours are policy, not in either feed, so we bake in SF's current rules
# (verified 2026-07, sfmta.com):
#   • Meters run 9am–10pm Mon–Sat; Sundays 12pm–6pm.
#   • No time limits after 6pm or any time Sunday.
#   • Sunday rates aren't published separately — the CSV has only Weekday + Weekend
#     (Weekend = Saturday's 9am–10pm grid). We approximate Sunday by clipping the
#     Saturday rates to the noon–6pm Sunday window. This is deliberately NOT "free on
#     Sunday" — SF meters Sundays, and a false free label sends drivers to a ticket.
import csv, json, math, re, urllib.parse, urllib.request

METERS = "https://data.sfgov.org/resource/8vzz-qzz9.json"
UA = {"User-Agent": "park-daddy/1.0 (hey.cchen@gmail.com)"}
PAGE = 50000

# Latest SFMTA quarterly rate file (download by hand — it's not an API). Swap this path
# when a new quarter posts. Schema has drifted between quarters, so the parser below is
# tolerant of both the full ("Time Band"/"Final Rate") and compact ("Time Band ID"/"Rate")
# layouts and skips the repeated header rows the compact file embeds mid-table.
RATE_CSV = "sf-rates.csv"

# General-purpose parking only — mirror Vancouver's "Any Vehicle" filter. Grey = standard,
# Green = short-term general. Drop Yellow (commercial), Black (motorcycle), Red, Brown.
CAP_KEEP = ("Grey", "Green")

# The fixed SF band grid, in minutes-from-midnight. SF's demand-responsive pricing uses
# these citywide bands; the CSV names them Time Band 1..4 (0 is a rare pre-9am split).
# "Open" resolves to 9am (Mon–Sat start), "Close" to 10pm — used when a row's explicit
# from/to is "Open"/"Close" or the compact file omits the columns entirely.
BAND = {0: (480, 540), 1: (540, 720), 2: (720, 900), 3: (900, 1080), 4: (1080, 1320)}
SUN_OPEN, SUN_CLOSE = 720, 1080   # Sunday metering window: 12pm–6pm


def fetch_meters():
    """All keep-worthy on-street SF meters as {block_key -> [[lat,lon], ...]}.
    active_meter_flag M = active meter, P = pay-by-plate paystation (also active paid
    parking) — keep both. Drop T (temporarily inactive), U (unmetered), L (future)."""
    where = ("on_offstreet_type='ON' AND active_meter_flag in('M','P') AND cap_color in('%s')"
             % "','".join(CAP_KEEP))
    q = {"$where": where, "$select": "street_name,street_num,latitude,longitude",
         "$limit": PAGE, "$offset": 0}
    blocks = {}
    n = 0
    while True:
        url = METERS + "?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            rows = json.load(r)
        for m in rows:
            try:
                lat, lon = float(m["latitude"]), float(m["longitude"])
            except (KeyError, ValueError, TypeError):
                continue
            key = block_key(m.get("street_name", ""), m.get("street_num", ""))
            if not key:
                continue
            blocks.setdefault(key, []).append([round(lat, 6), round(lon, 6)])
        n += len(rows)
        print(f"  fetched {n} meters …")
        if len(rows) < PAGE:
            break
        q["$offset"] += PAGE
    return blocks


def block_key(street_name, street_num):
    """Join key shared with the rate CSV: 'MISSION ST 2000' (street + hundred-block)."""
    street_name = (street_name or "").strip().upper()
    try:
        hundred = int(re.sub(r"\D", "", str(street_num)) or 0) // 100 * 100
    except ValueError:
        return None
    if not street_name:
        return None
    return f"{street_name} {hundred}"


def display_h(key):
    """Number-first, so app.js blockLabel reads '2000 block Mission St'. Strip the zero-
    pad on ordinal streets ('01ST ST 2000' -> '2000 1ST ST')."""
    parts = key.split()
    hundred = parts[-1]
    street = " ".join(parts[:-1]).lstrip("0")
    return f"{hundred} {street}".strip()


def clock(s):
    """'9:00 AM' -> 540. 'Open'/'Close'/'' -> None (caller falls back to the band grid)."""
    s = (s or "").strip().upper()
    m = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", s)
    if not m:
        return None
    h = int(m.group(1)) % 12
    if m.group(3) == "PM":
        h += 12
    return h * 60 + int(m.group(2))


def load_rates(path):
    """{block_key -> {'Weekday': [{r,s,e}...], 'Weekend': [...]}} from the SFMTA CSV.
    Tolerant of both quarterly schemas; GMP and Commercial rows are identical so we keep
    the first seen per (block, day, band). Only rate>0 bands are stored — everything else
    reads as free via bandRateNow's no-band-covers-now rule."""
    out = {}
    seen = set()
    with open(path, newline="") as f:
        for raw in csv.DictReader(f):
            row = {(k or "").strip(): (v or "").strip() for k, v in raw.items()}
            block = row.get("Street Block", "")
            day = row.get("Day Type") or row.get("Date Type") or ""
            if day not in ("Weekday", "Weekend"):   # skip blanks + embedded header rows
                continue
            bid = row.get("Time Band") or row.get("Time Band ID") or ""
            mb = re.search(r"(\d)", bid)
            if not mb or int(mb.group(1)) not in BAND:
                continue
            bid = int(mb.group(1))
            raw_rate = (row.get("Final Rate") or row.get("Rate") or "").replace("$", "").strip()
            try:
                rate = round(float(raw_rate), 2)
            except ValueError:
                continue
            dedup = (block, day, bid)
            if dedup in seen:
                continue
            seen.add(dedup)
            if rate <= 0:
                continue
            s = clock(row.get("Time Band From")) or BAND[bid][0]
            e = clock(row.get("Time Band To")) or BAND[bid][1]
            out.setdefault(block, {}).setdefault(day, []).append({"r": rate, "s": s, "e": e})
    for b in out.values():
        for day in b:
            b[day].sort(key=lambda x: x["s"])
    return out


def sunday_bands(sat):
    """Approximate Sunday from Saturday, clipped to the 12pm–6pm Sunday metering window."""
    out = []
    for band in sat:
        s, e = max(band["s"], SUN_OPEN), min(band["e"], SUN_CLOSE)
        if s < e:
            out.append({"r": band["r"], "s": s, "e": e})
    return out


def centroid(pts):
    return [round(sum(p[0] for p in pts) / len(pts), 6),
            round(sum(p[1] for p in pts) / len(pts), 6)]


def haversine(a, b):
    R, rad = 6371000, math.pi / 180
    dlat, dlon = (b[0] - a[0]) * rad, (b[1] - a[1]) * rad
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


# One rate covers a whole hundred-block, but rendering all its meters as a single centroid
# pill reads as sparse (a long corridor gets one pill per ~100 m). So we split each hundred-
# block's meters into ~block-face segments — greedy clusters within CLUSTER_M — matching
# Vancouver's per-face pill density. Every cluster inherits the hundred-block's rate bands.
CLUSTER_M = 45


def cluster(pts):
    used = [False] * len(pts)
    groups = []
    for i in range(len(pts)):
        if used[i]:
            continue
        used[i] = True
        grp = [pts[i]]
        for j in range(i + 1, len(pts)):
            if not used[j] and haversine(pts[i], pts[j]) <= CLUSTER_M:
                used[j] = True
                grp.append(pts[j])
        groups.append(grp)
    return groups


def build():
    print("Fetching SF meters (DataSF)…")
    meter_blocks = fetch_meters()
    print(f"  {len(meter_blocks)} blocks have keep-worthy meters")
    print(f"Loading rates ({RATE_CSV})…")
    rates = load_rates(RATE_CSV)
    print(f"  {len(rates)} blocks have published rates")

    out, unmatched, hundred_blocks = [], 0, 0
    for key, pts in meter_blocks.items():
        r = rates.get(key)
        if not r:
            unmatched += 1
            continue
        wkd = r.get("Weekday", [])
        sat = r.get("Weekend", [])
        if not wkd and not sat:
            continue
        hundred_blocks += 1
        sun = sunday_bands(sat)
        h = display_h(key)
        for grp in cluster(pts):   # one emitted block per curb-face segment (shared rate)
            c = centroid(grp)
            out.append({
                "h": h,
                "lat": c[0], "lon": c[1],
                "pts": grp,
                "spaces": len(grp),
                "wkd": wkd,
                "sat": sat,
                "sun": sun,
            })

    out.sort(key=lambda x: -max([b["r"] for b in x["wkd"]] or [0]))
    json.dump(out, open("data/sf-meters.json", "w"), separators=(",", ":"))
    print(f"\nWrote {len(out)} block-face segments across {hundred_blocks} priced hundred-blocks")
    print(f"  -> data/sf-meters.json  ({sum(len(x['pts']) for x in out)} meter dots)")
    print(f"  {unmatched} metered blocks had no rate row (dropped — can't price)")


if __name__ == "__main__":
    build()
