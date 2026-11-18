#!/usr/bin/env python3
"""
조사 이미지에서 집은 픽셀 자리를 위경도로 되돌려 data/doors.json 을 만든다.

입력은 건물 코드별 픽셀 목록. survey_capture.mjs 가 남긴 meta.json 의 bounds 를 쓴다.

    python3 tools/survey_pick.py picks.json

picks.json 모양:
    { "9": [[430, 610, "정문", true], [120, 330, "측문", false]], ... }
      x,  y,  라벨,   계단 없이 들어갈 수 있는가

100m 남짓한 범위라 위경도 선형 보간으로 충분하다 (메르카토르 휨은 cm 단위).
"""
import json
import os
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = Path(os.environ.get("OUT_DIR", "tmp"))  # 중간 산출물(스크린샷 등) 폴더. 레포에 안 올린다
SURVEY = OUT_DIR / "survey"



def seg_dist(p, a, b, mlon):
    """점에서 선분까지의 거리(m). 문이 벽에 붙어 있는지 확인하는 용도."""
    ax, ay = (a[1] - p[1]) * mlon, (a[0] - p[0]) * 111320
    bx, by = (b[1] - p[1]) * mlon, (b[0] - p[0]) * 111320
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(ax + dx * t, ay + dy * t)


def main(pick_file):
    meta = json.loads((SURVEY / "meta.json").read_text(encoding="utf-8"))
    picks = json.loads(Path(pick_file).read_text(encoding="utf-8"))
    picks.pop("_note", None)

    doors = []
    for code, items in picks.items():
        m = meta[code]
        b, W, H = m["bounds"], m["w"], m["h"]
        for x, y, label, acc in items:
            lat = b["n"] - (y / H) * (b["n"] - b["s"])
            lon = b["w"] + (x / W) * (b["e"] - b["w"])
            doors.append({
                "code": code,
                "at": [round(lat, 7), round(lon, 7)],
                "label": label,
                "accessible": bool(acc),
                "via": "roadview",
            })

    # 집은 자리가 건물에서 터무니없이 떨어졌으면 픽셀을 잘못 읽은 것이다. 바로 알려준다.
    bl = json.loads((ROOT / "data" / "buildings.json").read_text(encoding="utf-8"))["buildings"]
    poly = {b["code"]: b.get("polygon") or [] for b in bl}
    for d in doors:
        ring = poly.get(d["code"]) or []
        if len(ring) < 3:
            continue
        lat, lon = d["at"]
        mlon = 111320 * math.cos(math.radians(lat))
        best = min(
            seg_dist((lat, lon), ring[i], ring[(i + 1) % len(ring)], mlon)
            for i in range(len(ring))
        )
        if best > 15:
            print(f"  ! {d['code']} {d['label']}: 외곽선에서 {best:.0f}m 떨어져 있다 — 픽셀을 다시 보세요")

    have = {d["code"] for d in doors}
    missing = [b["name"] for b in bl if b["code"] not in have]

    out = ROOT / "data" / "doors.json"
    out.write_text(json.dumps({
        "_what": "건물별 실제 출입구. 스카이뷰(1px≈0.25m)와 로드뷰를 같이 보고 찍었다.",
        "_why": "OSM 에 entrance 태그가 0개고, 도로명주소 좌표는 건물 안쪽을 가리킨다. 공개 데이터가 없다.",
        "_how": "tools/survey_capture.mjs 로 건물마다 스카이뷰+로드뷰를 모아 보고, "
                "지붕 캐노피·보도블럭이 벽에 닿는 자리를 문으로 집어 tools/survey_pick.py 로 변환했다.",
        "_accuracy": "스카이뷰에서 집은 자리라 ±2m 정도 오차가 있다. 경로 안내에는 충분하다.",
        "doors": doors,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"문 {len(doors)}개 · 건물 {len(have)}/{len(bl)}곳 → {out.relative_to(ROOT)}")
    if missing:
        print(f"아직 안 찍은 건물 {len(missing)}곳: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "picks.json"))
