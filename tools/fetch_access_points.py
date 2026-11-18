#!/usr/bin/env python3
"""도로명주소 부번을 훑어 건물별 접근 지점을 모은다.

주의: 이 좌표는 출입구가 아니다. 실측해보니 17개 중 14개가 건물 폴리곤 안쪽
(최대 22m)에 찍혀 있었다. 주소의 대표 지점이다. 그래서 '출입구'가 아니라
'접근 지점'으로 쓴다 — 경로가 건물에 드나드는 자리의 근사치다.

진짜 출입구 좌표는 공개 데이터에 없다. 내비게이션용DB의 주출입구는 차량 진입
기준이라 캠퍼스 건물에는 잘 안 맞고, 심사도 필요하다.

카카오 주소검색 API 를 쓴다. JavaScript 키에 KA 헤더를 붙이면 통한다
(tools/geocode_missing.sh 와 같은 방식).

  python3 tools/fetch_address_doors.py            # 22-1 ~ 22-40
  python3 tools/fetch_address_doors.py 60         # 범위를 넓혀서
"""
import json, math, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROAD = "충남 아산시 신창면 순천향로 22"
MAX_SUB = int(sys.argv[1]) if len(sys.argv) > 1 else 40
EDGE_LIMIT = 15          # 건물 외곽선에서 이보다 멀면 그 건물 접근 지점으로 안 본다
ORIGIN = "http://localhost:5173"

key = ""
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if line.startswith("VITE_KAKAO_JS_KEY="):
        key = line.split("=", 1)[1].strip()
if not key:
    sys.exit(".env 에 VITE_KAKAO_JS_KEY 가 없습니다")

blds = json.loads((ROOT / "data" / "buildings.json").read_text(encoding="utf-8"))["buildings"]
K = math.cos(math.radians(36.77)) * 111_000


def meters(a, b):
    return math.hypot((a[0] - b[0]) * 111_000, (a[1] - b[1]) * K)


def inside(p, poly):
    """점이 다각형 안에 있나 (건물 안 좌표인지 구분용)."""
    if len(poly) < 3:
        return False
    x, y, ins, n = p[1], p[0], False, len(poly)
    for i in range(n):
        x1, y1 = poly[i][1], poly[i][0]
        x2, y2 = poly[(i + 1) % n][1], poly[(i + 1) % n][0]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            ins = not ins
    return ins


def dist_to_boundary(p, poly):
    """점에서 건물 외곽선까지의 최단 거리.

    중심까지의 거리로 판단하면 긴 건물에서 엉뚱한 점을 받아들이게 된다.
    출입구는 외곽선 바로 옆에 있어야 한다.
    """
    if len(poly) < 2:
        return float("inf")
    best = float("inf")
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        ax, ay = (a[1] - p[1]) * K, (a[0] - p[0]) * 111_000
        bx, by = (b[1] - p[1]) * K, (b[0] - p[0]) * 111_000
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            d = math.hypot(ax, ay)
        else:
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
            d = math.hypot(ax + dx * t, ay + dy * t)
        best = min(best, d)
    return best


def lookup(query: str):
    url = "https://dapi.kakao.com/v2/local/search/address.json?" + urllib.parse.urlencode(
        {"query": query, "size": 1}
    )
    req = urllib.request.Request(url, headers={
        "Authorization": f"KakaoAK {key}",
        "KA": f"sdk/1.0.0 os/javascript origin/{ORIGIN}",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        docs = json.load(r).get("documents") or []
    return (float(docs[0]["y"]), float(docs[0]["x"])) if docs else None


found, rejected, skipped = [], [], 0
for n in range(1, MAX_SUB + 1):
    pt = lookup(f"{ROAD}-{n}")
    time.sleep(0.05)
    if not pt:
        skipped += 1
        continue

    # 외곽선까지의 거리로 고른다. 캠퍼스에는 코드표에 없는 건물(프라임관, 부속동 등)이
    # 많아서 "가장 가까운 강의동"에 억지로 붙이면 엉뚱한 점이 출입구가 된다.
    ranked = sorted(
        ((dist_to_boundary(pt, [tuple(q) for q in b["polygon"]]), b) for b in blds if len(b["polygon"]) >= 3),
        key=lambda x: x[0],
    )
    if not ranked:
        continue
    d_edge, best = ranked[0]
    is_in = inside(pt, [tuple(q) for q in best["polygon"]])
    rec = {
        "code": best["code"], "name": best["name"], "address": f"순천향로 22-{n}",
        "at": [round(pt[0], 7), round(pt[1], 7)],
        "meters_from_edge": round(d_edge, 1),
        "inside_polygon": is_in,
        "source": "address",
    }
    # 건물 안이거나 외곽선 바로 옆인 것만 접근 지점으로 인정한다.
    (found if (is_in or d_edge <= EDGE_LIMIT) else rejected).append(rec)

(ROOT / "data" / "access-points.json").write_text(json.dumps({
    "_what": "도로명주소 부번의 좌표. 도로명주소는 주출입구 기준으로 부여된다.",
    "_source": "카카오 주소검색 API (dapi.kakao.com/v2/local/search/address.json)",
    "_rule": f"건물 폴리곤 안이거나 외곽선에서 {EDGE_LIMIT}m 이내인 점만 인정한다.",
    "_road": ROAD,
    "access_points": found,
    "rejected": rejected,
}, ensure_ascii=False, indent=2), encoding="utf-8")

by_code = {}
for d in found:
    by_code.setdefault(d["code"], []).append(d)

print(f"주소 {MAX_SUB}개 조회 · 없는 부번 {skipped}개")
print(f"접근 지점으로 인정 {len(found)}개 · 버림 {len(rejected)}개 (외곽선 {EDGE_LIMIT}m 초과)")
print(f"접근 지점이 붙은 건물 {len(by_code)}/{len(blds)}곳\n")
for b in blds:
    ds = by_code.get(b["code"], [])
    if not ds:
        print(f"  {b['code']:>2} {b['name']:<14} —")
        continue
    marks = ", ".join(
        f"{d['address'].split()[-1]}({d['meters_from_edge']:.0f}m"
        + ("" if d["inside_polygon"] else ", 외곽") + ")"
        for d in ds
    )
    print(f"  {b['code']:>2} {b['name']:<14} {marks}")

if rejected:
    print("\n버린 주소 (가까운 건물 외곽선에서 멀다 — 코드표에 없는 부속동일 가능성)")
    for r in sorted(rejected, key=lambda r: -r["meters_from_edge"]):
        print(f"  {r['address'].split()[-1]:<6} {r['name']:<14} 외곽선에서 {r['meters_from_edge']:5.0f}m")
