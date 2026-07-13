#!/usr/bin/env python3
# Build San Jose's paid-parking layer from the City of San Jose open-data ArcGIS service.
#
# San Jose is the SIMPLEST shape Park Daddy handles: POINT meters (dots, like Vancouver/SF)
# at a FLAT $2/hr rate, Mon–Sat 9am–6pm, free Sundays — no demand-responsive bands. We still
# emit it in the Seattle/SF "bands" format (one flat band during operating hours, empty on
# Sunday) so it reuses bandRateNow / seattleDaySegments / limitFor unchanged. Unlike SF, the
# feed DOES carry a per-meter time limit (PARKINGDURATION), so limitMin is populated.
#
# Source: City of San Jose "Parking Meters" layer (ArcGIS MapServer, no key, refreshed weekly).
#   Portal: https://gisdata-csj.opendata.arcgis.com/datasets/CSJ::parking-meters
# Rate/hours model (city Parking Meter Rates page — NOT in the feed, baked in here):
#   • Flat $2.00/hr, Mon–Sat 9am–6pm, free Sundays + city holidays.
#   • Per-meter time limits 3–240 min (PARKINGDURATION). No limits outside enforcement.
#   • Event surge pricing near SAP Center / Convention Center ($0–$25) is dynamic and NOT
#     published in open data — we intentionally don't model it (would be a guess).
import json, math, urllib.parse, urllib.request
from collections import Counter

BASE = ("https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService"
        "/MapServer/422/query")
UA = {"User-Agent": "park-daddy/1.0 (hey.cchen@gmail.com)"}
PAGE = 1000

OPEN, CLOSE = 540, 1080   # 9:00am–6:00pm enforcement window (minutes from midnight)
CLUSTER_M = 45            # greedy block-face clustering radius, matches build-sf.py

FIELDS = "METERID,PARKINGRATE,PARKINGDURATION,METERADDRESS,LATITUDE,LONGITUDE"


def fetch_all():
    """Active ($ rate) on-street meters. DEACTIVATED='No' filters retired meters; we keep
    only rows that carry a real PARKINGRATE (≈142 have none — EV/unpriced — and can't price)."""
    feats, off = [], 0
    while True:
        q = {"where": "DEACTIVATED='No' AND PARKINGRATE IS NOT NULL",
             "outFields": FIELDS, "returnGeometry": "false", "f": "json",
             "resultOffset": off, "resultRecordCount": PAGE}
        url = BASE + "?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            page = json.load(r)
        f = page.get("features", [])
        feats.extend(a["attributes"] for a in f)
        print(f"  fetched {len(feats)} …")
        if len(f) < PAGE:
            break
        off += PAGE
    return feats


def duration_min(s):
    """'120 Min' -> 120, None -> None."""
    if not s:
        return None
    digits = "".join(c for c in str(s) if c.isdigit())
    return int(digits) if digits else None


def haversine(a, b):
    R, rad = 6371000, math.pi / 180
    dlat, dlon = (b[0] - a[0]) * rad, (b[1] - a[1]) * rad
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def cluster(idx, pts):
    """Greedy block-face clustering (same as build-sf.py): each unused meter seeds a group
    grabbing every other meter within CLUSTER_M. Returns lists of original indices."""
    used = [False] * len(idx)
    groups = []
    for i in range(len(idx)):
        if used[i]:
            continue
        used[i] = True
        grp = [i]
        for j in range(i + 1, len(idx)):
            if not used[j] and haversine(pts[i], pts[j]) <= CLUSTER_M:
                used[j] = True
                grp.append(j)
        groups.append(grp)
    return groups


def title(s):
    return " ".join(w.capitalize() for w in str(s or "").split())


def build():
    print("Fetching San Jose meters (ArcGIS)…")
    rows = fetch_all()
    meters = []
    for m in rows:
        try:
            lat, lon = float(m["LATITUDE"]), float(m["LONGITUDE"])
        except (KeyError, ValueError, TypeError):
            continue
        try:
            rate = round(float(m["PARKINGRATE"]), 2)
        except (KeyError, ValueError, TypeError):
            continue
        meters.append({"lat": lat, "lon": lon, "rate": rate,
                       "dur": duration_min(m.get("PARKINGDURATION")),
                       "addr": m.get("METERADDRESS")})
    print(f"  {len(meters)} priced meters")

    pts = [[m["lat"], m["lon"]] for m in meters]
    out = []
    for grp in cluster(list(range(len(meters))), pts):
        g = [meters[i] for i in grp]
        c = [round(sum(m["lat"] for m in g) / len(g), 6),
             round(sum(m["lon"] for m in g) / len(g), 6)]
        # one rate/limit per curb face: the modal value across the cluster's meters, so a
        # lone 12-min loading meter never drags a 2-hour block down to 12 min.
        rate = Counter(m["rate"] for m in g).most_common(1)[0][0]
        durs = [m["dur"] for m in g if m["dur"]]
        limit = Counter(durs).most_common(1)[0][0] if durs else None
        addr = next((m["addr"] for m in g if m.get("addr")), None)
        band = [{"r": rate, "s": OPEN, "e": CLOSE}]   # flat rate across the 9–6 window
        out.append({
            "h": title(addr),
            "lat": c[0], "lon": c[1],
            "pts": [[round(m["lat"], 6), round(m["lon"], 6)] for m in g],
            "spaces": len(g),
            "limit": limit,
            "wkd": band,
            "sat": band,          # Saturday metered same as weekday (9–6)
            "sun": [],            # free on Sundays
        })

    out.sort(key=lambda x: -x["spaces"])
    json.dump(out, open("data/sanjose-meters.json", "w"), separators=(",", ":"))
    print(f"\nWrote {len(out)} block-face segments -> data/sanjose-meters.json"
          f"  ({sum(len(x['pts']) for x in out)} meter dots)")


if __name__ == "__main__":
    build()
