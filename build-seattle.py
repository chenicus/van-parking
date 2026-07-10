#!/usr/bin/env python3
# Build Seattle's paid-parking layer from SDOT's Blockface feature service.
# Unlike Vancouver (point-per-meter), Seattle prices by BLOCKFACE — one side of a
# street between two intersections — so every record is a polyline with a paid-space
# count and time-of-day rate bands attached. We keep the line geometry (drawn colored
# by rate) plus a midpoint (anchors the price pill) and normalize the rate bands.
#
# Source: https://data-seattlecitygis.opendata.arcgis.com/datasets/SeattleCityGIS::blockface-1
import json, urllib.parse, urllib.request

BASE = ("https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services"
        "/Blockface/FeatureServer/1/query")
UA = {"User-Agent": "park-daddy/1.0 (hey.cchen@gmail.com)"}
PAGE = 1000

# Category -> our compact tag. Anything else (Unrestricted / No Parking) is dropped.
CAT = {
    "Paid Parking": "paid",
    "Restricted Parking Zone": "rpz",
    "Time Limited Parking": "tl",
}

FIELDS = ("UNITDESC,PARKING_CATEGORY,PAID_SPACES,RPZ_ZONE,PARKING_TIME_LIMIT,"
          "PEAK_HOUR,START_TIME_WKD,END_TIME_WKD,"
          "WKD_RATE1,WKD_START1,WKD_END1,WKD_RATE2,WKD_START2,WKD_END2,WKD_RATE3,WKD_START3,WKD_END3,"
          "SAT_RATE1,SAT_START1,SAT_END1,SAT_RATE2,SAT_START2,SAT_END2,SAT_RATE3,SAT_START3,SAT_END3,"
          "SUN_RATE1,SUN_START1,SUN_END1,SUN_RATE2,SUN_START2,SUN_END2,SUN_RATE3,SUN_START3,SUN_END3")


def fetch(where, fields, offset):
    q = {
        "where": where,
        "outFields": fields,
        "outSR": "4326",
        "f": "geojson",
        "resultOffset": offset,
        "resultRecordCount": PAGE,
    }
    url = BASE + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fetch_all(where, fields):
    feats, offset = [], 0
    while True:
        page = fetch(where, fields, offset)
        f = page.get("features", [])
        feats.extend(f)
        print(f"  fetched {len(feats)} …")
        if len(f) < PAGE:
            break
        offset += PAGE
    return feats


def bands(p, day):
    """Three (rate, start, end) tuples for a day -> list of {r,s,e}, dropping empties.
    Seattle stores END as the last active minute (e.g. 659 = 10:59 for an 8–11am band);
    we store the exclusive end (+1) so consecutive bands are contiguous — no 1-min gaps."""
    out = []
    for i in (1, 2, 3):
        rate = p.get(f"{day}_RATE{i}")
        s, e = p.get(f"{day}_START{i}"), p.get(f"{day}_END{i}")
        if not rate or s is None or e is None:
            continue
        out.append({"r": round(rate, 2), "s": s, "e": e + 1})
    return out


def midpoint(coords):
    """Point at half the polyline's arc length — where the pill sits."""
    if len(coords) == 1:
        return coords[0]
    segs = []
    total = 0.0
    for a, b in zip(coords, coords[1:]):
        d = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        segs.append(d)
        total += d
    half = total / 2
    run = 0.0
    for (a, b), d in zip(zip(coords, coords[1:]), segs):
        if run + d >= half:
            t = 0 if d == 0 else (half - run) / d
            return [round(a[0] + (b[0] - a[0]) * t, 6), round(a[1] + (b[1] - a[1]) * t, 6)]
        run += d
    return coords[-1]


def coords_of(ft):
    g = ft.get("geometry")
    if not g or not g.get("coordinates"):
        return None
    coords = g["coordinates"]
    if coords and isinstance(coords[0][0], list):   # MultiLineString guard
        coords = coords[0]
    return [[round(x, 6), round(y, 6)] for x, y in coords]


def build_paid():
    print("Paid blockfaces…")
    feats = fetch_all("PAID_SPACES > 0", FIELDS)

    out = []
    for ft in feats:
        p = ft.get("properties", {})
        cat = CAT.get(p.get("PARKING_CATEGORY"))
        if not cat:
            continue
        coords = coords_of(ft)
        if not coords:
            continue
        wkd = bands(p, "WKD")
        peak = max([b["r"] for b in wkd + bands(p, "SAT") + bands(p, "SUN")] or [0])
        out.append({
            "h": (p.get("UNITDESC") or "").title(),
            "cat": cat,
            "spaces": int(p.get("PAID_SPACES") or 0),
            "limit": int(p.get("PARKING_TIME_LIMIT") or 0),   # minutes
            "rpz": p.get("RPZ_ZONE") or None,
            "peak": round(peak, 2),
            "line": coords,
            "mid": midpoint(coords),   # [lon, lat]
            "wkd": wkd,
            "sat": bands(p, "SAT"),
            "sun": bands(p, "SUN"),
        })

    out.sort(key=lambda x: -x["peak"])
    json.dump(out, open("data/seattle-meters.json", "w"), separators=(",", ":"))
    by = {}
    for o in out:
        by[o["cat"]] = by.get(o["cat"], 0) + 1
    print(f"\nWrote {len(out)} paid blockfaces -> data/seattle-meters.json  {by}")


# The free layer: streets you can park on for free. Unrestricted = free, unlimited;
# Time Limited = free but capped (e.g. 2 hr). Kept lean (no rate bands) — these ride the
# same blue "free" rendering as Vancouver's free blocks.
FREE_FIELDS = "UNITDESC,PARKING_CATEGORY,PARKING_TIME_LIMIT,TOTAL_SPACES"


def build_free():
    print("Free + time-limited blockfaces…")
    where = ("PARKING_CATEGORY IN ('Unrestricted Parking','Time Limited Parking') "
             "AND TOTAL_SPACES > 0")
    feats = fetch_all(where, FREE_FIELDS)

    out = []
    for ft in feats:
        p = ft.get("properties", {})
        coords = coords_of(ft)
        if not coords:
            continue
        tl = p.get("PARKING_CATEGORY") == "Time Limited Parking"
        rec = {
            "h": (p.get("UNITDESC") or "").title(),
            "cat": "tl" if tl else "free",
            "spaces": int(p.get("TOTAL_SPACES") or 0),
            "line": coords,
            "mid": midpoint(coords),
        }
        if tl:
            rec["limit"] = int(p.get("PARKING_TIME_LIMIT") or 0)   # free, but time-capped
        out.append(rec)

    json.dump(out, open("data/seattle-free.json", "w"), separators=(",", ":"))
    by = {}
    for o in out:
        by[o["cat"]] = by.get(o["cat"], 0) + 1
    print(f"\nWrote {len(out)} free blockfaces -> data/seattle-free.json  {by}")


if __name__ == "__main__":
    print("Downloading Seattle blockface data…")
    build_paid()
    build_free()
