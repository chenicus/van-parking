#!/usr/bin/env python3
# Shared by build-sf.py and build-sf-free.py: SF's scheduled tow-away ("no stopping")
# zones, joined onto whatever curb geometry a caller already has.
#
# WHY THIS EXISTS: SF posts weekday peak-hour tow-away zones on commute corridors (Battery,
# Bush, Pine, 3rd, …). During the window the curb is NOT parkable at any price — a metered
# block is tow-away, and a "free" time-limited block is tow-away — but neither the meter feed
# nor the parking-regulation feed carries this. So a block Park Daddy would otherwise draw as
# Free/Paid is really a tow zone 3–6pm, and a driver who trusts the pill gets towed. This
# module supplies the missing windows; the app already knows how to act on them (they ride the
# existing `prohibitions` machinery — pill hidden while active, "Tow-away" carved into the
# schedule, an upcoming-tow warning on the card).
#
# SOURCE: DataSF "Regularly scheduled tow-away zone GIS data" — query the TABLE `ynvq-waab`
# (Socrata, no key, 588 blockfaces). NOT its map view `wnhf-gu86`, whose resource/GeoJSON
# export endpoints return empty. One row per blockface: a (mostly 2-point) centerline polyline,
# a `side` (Left/Right), and one or two windows (`tow{1,2}days/start/end`). CAVEAT: last
# refreshed 2023-10 — tow corridors change slowly, but it is not live. The "new format" notice
# on the dataset points to a story that now sits behind SFMTA staff sign-in.
#
# SIDE OF STREET is load-bearing: a tow zone is one curb, not the whole street, so applying it
# to both sides would hide/​warn parkable curb opposite the zone. Derived empirically against
# ~5k meters with known street numbers: cross((end-start),(pt-start)) > 0  ⟺  odd address  ⟺
# `side` == "Left"; < 0  ⟺  even  ⟺  "Right" (each held ~90%+; noise is corner/mislocated
# meters). We only attach a window to a block whose centroid lands on the row's `side`.
import json, math, urllib.parse, urllib.request

TOWAWAY = "https://data.sfgov.org/resource/ynvq-waab.json"
UA = {"User-Agent": "park-daddy/1.0 (hey.cchen@gmail.com)"}
PAGE = 5000

# Day tokens → bit index matching rank.js dayHas (Sun=0 … Sat=6). "Ho" (holiday) is dropped:
# the app has no holiday calendar, and over-warning one holiday afternoon beats a wrong free label.
DAY_BIT = {"Su": 0, "Mo": 1, "Tu": 2, "We": 3, "Th": 4, "Fr": 5, "Sa": 6}
ZONE = "TOW-AWAY"                      # rank.js/app.js ZONE_LABEL renders this as "Tow-away"

# Equirectangular meters at SF's latitude — good to <0.1% over a city, and side/proximity here
# only care about ~tens of meters.
M_PER_DEG = 111320.0
COS = math.cos(math.radians(37.77))

DMAX_PERP = 24.0                       # a curb sits within this of its street centerline
LONG_PAD = 0.25                        # let a block overhang the tow segment's ends by this fraction
ANGLE_COS = math.cos(math.radians(35))  # block must run ~parallel to the tow segment (reject cross streets)
CELL = 200.0                           # spatial-hash cell (m)


def _xy(lon, lat):
    return (lon * M_PER_DEG * COS, lat * M_PER_DEG)


def _hhmm(s):
    """'1530' -> 930, '2400' -> 1440, '0' -> 0, '' -> None."""
    try:
        v = int(s)
    except (TypeError, ValueError):
        return None
    return (v // 100) * 60 + (v % 100)


def _daymask(s):
    mask = 0
    for tok in (s or "").split(","):
        b = DAY_BIT.get(tok.strip())
        if b is not None:
            mask |= 1 << b
    return mask


def _windows(row):
    """A row's one or two tow windows as [{days,start,end,zone}]. A window with start>end wraps
    past midnight — left as-is; rank.js prohibitionNow assigns the after-midnight tail to the day
    the window started."""
    out = []
    for ds, ss, es in (("tow1days", "tow1start", "tow1end"), ("tow2days", "tow2start", "tow2end")):
        days = _daymask(row.get(ds))
        s, e = _hhmm(row.get(ss)), _hhmm(row.get(es))
        if not days or s is None or e is None or s == e:
            continue
        out.append({"days": days, "start": s, "end": e, "zone": ZONE})
    return out


def fetch_towaway():
    rows, offset = [], 0
    while True:
        q = {"$limit": PAGE, "$offset": offset}
        req = urllib.request.Request(TOWAWAY + "?" + urllib.parse.urlencode(q), headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            page = json.load(r)
        rows.extend(page)
        if len(page) < PAGE:
            return rows
        offset += PAGE


class TowMatcher:
    """Build once from fetch_towaway(); call match() per block with its curb points."""

    def __init__(self, rows):
        self.segs = []      # (ax, ay, bx, by, dx, dy, L, side, windows)
        self.grid = {}
        for row in rows:
            wins = _windows(row)
            if not wins:
                continue
            side = row.get("side")
            g = row.get("geometry") or {}
            cs = g.get("coordinates") or []
            for a, b in zip(cs, cs[1:]):
                ax, ay = _xy(a[0], a[1])
                bx, by = _xy(b[0], b[1])
                dx, dy = bx - ax, by - ay
                L = math.hypot(dx, dy)
                if L < 1:
                    continue
                idx = len(self.segs)
                self.segs.append((ax, ay, bx, by, dx, dy, L, side, wins))
                lo_i, hi_i = int((min(ax, bx) - DMAX_PERP) / CELL), int((max(ax, bx) + DMAX_PERP) / CELL)
                lo_j, hi_j = int((min(ay, by) - DMAX_PERP) / CELL), int((max(ay, by) + DMAX_PERP) / CELL)
                for ci in range(lo_i, hi_i + 1):
                    for cj in range(lo_j, hi_j + 1):
                        self.grid.setdefault((ci, cj), []).append(idx)

    @staticmethod
    def _dir(P):
        """Block heading = vector between its two farthest curb points (None if degenerate)."""
        best, bi, bj = -1.0, 0, 0
        for i in range(len(P)):
            for j in range(i + 1, len(P)):
                d = (P[i][0] - P[j][0]) ** 2 + (P[i][1] - P[j][1]) ** 2
                if d > best:
                    best, bi, bj = d, i, j
        if best < 1:
            return None
        return (P[bj][0] - P[bi][0], P[bj][1] - P[bi][1])

    def match(self, pts_lonlat):
        """pts_lonlat: [(lon, lat), …] curb points for one block (meter points, or line vertices).
        Returns deduped [{days,start,end,zone}] for every tow segment this block runs along, on the
        segment's own side of the street. Empty when the block touches no tow zone."""
        if not pts_lonlat:
            return []
        P = [_xy(lon, lat) for lon, lat in pts_lonlat]
        cx = sum(p[0] for p in P) / len(P)
        cy = sum(p[1] for p in P) / len(P)
        bd = self._dir(P)
        ci, cj = int(cx / CELL), int(cy / CELL)
        cand = set()
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                cand.update(self.grid.get((ci + di, cj + dj), ()))
        found, seen = [], set()
        for idx in cand:
            ax, ay, bx, by, dx, dy, L, side, wins = self.segs[idx]
            if bd is not None:                                   # reject cross streets
                cosang = abs((bd[0] * dx + bd[1] * dy) / (L * math.hypot(*bd)))
                if cosang < ANGLE_COS:
                    continue
            t = ((cx - ax) * dx + (cy - ay) * dy) / (L * L)      # longitudinal position along seg
            if t < -LONG_PAD or t > 1 + LONG_PAD:
                continue
            tc = max(0.0, min(1.0, t))
            if math.hypot(cx - (ax + tc * dx), cy - (ay + tc * dy)) > DMAX_PERP:
                continue
            cross = dx * (cy - ay) - dy * (cx - ax)              # >0 ⟺ Left curb (see header)
            if side and ("Left" if cross > 0 else "Right") != side:
                continue
            for w in wins:
                k = (w["days"], w["start"], w["end"])
                if k not in seen:
                    seen.add(k)
                    found.append(w)
        return found
