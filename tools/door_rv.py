#!/usr/bin/env python3
"""
로드뷰 관측(촬영 지점 + 방위각)으로 출입구 좌표를 구해 data/doors.json 에 넣는다.

근거는 data/door-evidence.json 에 남긴다. 건물별로:
    {"label": "정문", "rays": [[lat, lon, bearing], ...], "note": "..."}
        방향선이 2개 이상 → 최소제곱 교차점 (외곽선에 의존하지 않는다)
        방향선이 1개      → 그 선이 건물 외곽선과 처음 만나는 점
    {"label": "북문", "at": [lat, lon], "note": "...", "confirmed": false}
        로드뷰로 못 본 문. 위성에서 광장·보행로가 벽에 닿는 자리를 직접 적는다.

    python3 tools/door_rv.py U pano 4 340      # 촬영 지점 번호를 좌표로 풀어 보여준다
    python3 tools/door_rv.py apply             # door-evidence.json → doors.json
"""
import json
import os
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = Path(os.environ.get("OUT_DIR", "tmp"))  # 중간 산출물(스크린샷 등) 폴더. 레포에 안 올린다
RV = OUT_DIR / "rv"
EVID = ROOT / "data" / "door-evidence.json"


def local(p, o):
    K = 111320 * math.cos(math.radians(o[0]))
    return ((p[1] - o[1]) * K, (p[0] - o[0]) * 111320)


def unlocal(x, y, o):
    K = 111320 * math.cos(math.radians(o[0]))
    return (o[0] + y / 111320, o[1] + x / K)


def ray_dir(b):
    r = math.radians(b)
    return (math.sin(r), math.cos(r))


def spread(rays):
    """방향선들 사이 최대 각도 차."""
    bs = [r[2] for r in rays]
    return max(abs((a - b + 180) % 360 - 180) for a in bs for b in bs)


def triangulate(rays):
    o = (rays[0][0], rays[0][1])
    # 각 방향선에 수직인 거리 제곱합을 최소로: sum (I - d d^T)(x - p) = 0
    A = [[0.0, 0.0], [0.0, 0.0]]
    bv = [0.0, 0.0]
    for la, lo, br in rays:
        px, py = local((la, lo), o)
        dx, dy = ray_dir(br)
        m = [[1 - dx * dx, -dx * dy], [-dx * dy, 1 - dy * dy]]
        for i in range(2):
            for j in range(2):
                A[i][j] += m[i][j]
            bv[i] += m[i][0] * px + m[i][1] * py
    det = A[0][0] * A[1][1] - A[0][1] * A[1][0]
    x = (bv[0] * A[1][1] - A[0][1] * bv[1]) / det
    y = (A[0][0] * bv[1] - A[1][0] * bv[0]) / det
    # 방향선이 거의 평행하면 교차점이 멀리 튄다 — 잔차로 확인
    resid = []
    for la, lo, br in rays:
        px, py = local((la, lo), o)
        dx, dy = ray_dir(br)
        t = (x - px) * dx + (y - py) * dy
        resid.append(math.hypot(x - (px + t * dx), y - (py + t * dy)))
        if t < 0:
            raise ValueError("교차점이 촬영 지점 뒤쪽에 있다 — 방위각을 확인")
    return unlocal(x, y, o), max(resid)


def hit_polygon(ray, ring):
    la, lo, br = ray
    o = (la, lo)
    dx, dy = ray_dir(br)
    best = None
    pts = [local(tuple(q), o) for q in ring]
    for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
        ex, ey = bx - ax, by - ay
        den = dx * ey - dy * ex
        if abs(den) < 1e-9:
            continue
        t = (ax * ey - ay * ex) / den
        u = (ax * dy - ay * dx) / den
        if t > 1 and 0 <= u <= 1 and (best is None or t < best):
            best = t
    if best is None:
        return None
    return unlocal(dx * best, dy * best, o)


SNAP_MAX = 6.0   # 교차점이 벽에서 이 안이면 벽 위로 붙인다 (방위각 1~2° 오차가 몇 m 로 번진다)


def snap_to_wall(at, ring):
    """가장 가까운 외곽선 위의 점과 그 거리(m)."""
    o = at
    best = None
    pts = [local(tuple(q), o) for q in ring]
    for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
        qx, qy = ax + dx * t, ay + dy * t
        d = math.hypot(qx, qy)
        if best is None or d < best[0]:
            best = (d, unlocal(qx, qy, o))
    return best[1], best[0]


def pano(code, idx, bearing):
    panos = json.loads((RV / f"{code}-panos.json").read_text())
    at = panos[int(idx)]["at"]
    print(json.dumps([round(at[0], 7), round(at[1], 7), float(bearing)]))


def apply():
    ev = json.loads(EVID.read_text(encoding="utf-8"))
    bl = {b["code"]: b for b in json.loads((ROOT / "data" / "buildings.json").read_text(encoding="utf-8"))["buildings"]}
    doors_file = ROOT / "data" / "doors.json"
    dj = json.loads(doors_file.read_text(encoding="utf-8"))
    done = {c for c in ev if c in bl}   # "_checked" 같은 메모 키는 건너뛴다
    kept = [d for d in dj["doors"] if d["code"] not in done]
    added = []
    for code in sorted(done):
        ring = bl[code].get("polygon") or []
        for d in ev[code]:
            if "at" in d:
                at, how = tuple(d["at"]), d.get("how", "위성")
            elif len(d["rays"]) >= 2 and spread(d["rays"]) >= 12:
                at, res = triangulate(d["rays"])
                how = f"로드뷰 {len(d['rays'])}방향 교차 (잔차 {res:.1f}m)"
                if res > 3:
                    print(f"  ! {code} {d['label']}: 방향선이 {res:.1f}m 어긋난다 — 방위각을 다시 볼 것")
            elif len(d["rays"]) >= 2:
                # 방향선이 거의 나란하면(촬영 지점이 붙어 있으면) 교차점이 불안정하다.
                # 각 선이 벽과 만나는 점을 구해 평균한다 — 서로 얼마나 떨어졌는지가 곧 오차다.
                hits = [h for h in (hit_polygon(r, ring) for r in d["rays"]) if h]
                if not hits:
                    print(f"  ! {code} {d['label']}: 방향선이 외곽선과 안 만난다")
                    continue
                at = (sum(h[0] for h in hits) / len(hits), sum(h[1] for h in hits) / len(hits))
                spread_m = max(math.hypot(*local(h, at)) for h in hits)
                how = f"로드뷰 {len(hits)}방향 × 외곽선 평균 (흩어짐 {spread_m:.1f}m)"
                if spread_m > 4:
                    print(f"  ! {code} {d['label']}: 방향선들이 벽에서 {spread_m:.1f}m 흩어진다 — 방위각을 다시 볼 것")
            else:
                at = hit_polygon(d["rays"][0], ring) if len(ring) >= 3 else None
                how = "로드뷰 1방향 + 외곽선"
                if at is None:
                    print(f"  ! {code} {d['label']}: 방향선이 외곽선과 안 만난다")
                    continue
            if len(ring) >= 3 and ("rays" in d or d.get("snap")):
                snapped, dist = snap_to_wall(at, ring)
                if dist <= SNAP_MAX:
                    at = snapped
                    how += f" → 벽에 붙임({dist:.1f}m)"
                else:
                    print(f"  ! {code} {d['label']}: 벽에서 {dist:.1f}m 떨어져 있다 — 외곽선이나 방위각 확인")
            rec = {"code": code, "at": [round(at[0], 7), round(at[1], 7)], "label": d["label"],
                   "accessible": bool(d.get("accessible", False)),
                   "via": "roadview" if "rays" in d else d.get("via", "satellite"),
                   "confirmed": d.get("confirmed", "rays" in d)}
            # 있는 문이지만 길찾기에는 안 쓰는 문 (이유를 같이 남긴다)
            for k in ("routing", "routing_why", "confirmed_by"):
                if k in d:
                    rec[k] = d[k]
            added.append(rec)
            print(f"  {bl[code]['name']:<10} {d['label']:<6} {at[0]:.6f},{at[1]:.6f}  {how}")
    dj["doors"] = sorted(kept + added, key=lambda d: (d["code"], d["label"]))
    dj["_how"] = ("로드뷰에서 문(유리문·캐노피·간판)이 보이는 방위각을 읽고, 촬영 지점에서 그은 방향선의 교차점 "
                  "(또는 건물 외곽선과의 교점)으로 잡았다. 근거는 data/door-evidence.json. "
                  "로드뷰가 닿지 않는 문만 위성으로 찍고 confirmed:false 로 둔다.")
    doors_file.write_text(json.dumps(dj, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"건물 {len(done)}곳 문 {len(added)}개 반영 (나머지 건물 {len({d['code'] for d in kept})}곳은 기존 유지)")


if __name__ == "__main__":
    if sys.argv[1] == "pano":
        pano(*sys.argv[2:5])
    else:
        apply()
