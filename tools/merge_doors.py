#!/usr/bin/env python3
"""
팀원들이 /?edit 에서 받은 doors-*.json 들을 data/doors.json 하나로 합친다.

    python3 tools/merge_doors.py ~/Downloads/doors-*.json

같은 문을 두 사람이 찍는 일이 생긴다 (담당이 겹치거나, 한 명이 다시 확인하거나).
3m 안에 있으면 같은 문으로 보고 하나만 남긴다 — 로드뷰로 확인한 쪽을 우선한다.
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAME_DOOR = 3.0   # m. 이보다 가까우면 같은 문으로 본다


def meters(a, b):
    dlat = (b[0] - a[0]) * 111_320
    dlon = (b[1] - a[1]) * 111_320 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon)


def main(paths):
    if not paths:
        print(__doc__)
        return 1

    kept, dropped, sources = [], 0, []
    for p in paths:
        doc = json.loads(Path(p).read_text(encoding="utf-8"))
        sources.append(f"{Path(p).name} ({doc.get('_surveyor', '?')}, {len(doc['doors'])}개)")
        for d in doc["doors"]:
            twin = next(
                (k for k in kept
                 if k["code"] == d["code"] and meters(k["at"], d["at"]) < SAME_DOOR),
                None,
            )
            if twin is None:
                kept.append(dict(d))
                continue
            dropped += 1
            # 겹쳤으면 더 확실한 쪽을 남긴다
            if twin.get("via") != "roadview" and d.get("via") == "roadview":
                twin.update(d)
            # 계단 없음은 한 사람이라도 확인했으면 남긴다
            twin["accessible"] = bool(twin.get("accessible") or d.get("accessible"))

    kept.sort(key=lambda d: (d["code"], d["at"]))
    out = ROOT / "data" / "doors.json"
    out.write_text(json.dumps({
        "_what": "재학생이 스카이뷰·로드뷰를 보며 직접 찍은 실제 출입구.",
        "_why": "OSM 에 entrance 태그가 0개, 도로명주소 좌표는 건물 안쪽을 가리킨다. 공개 데이터가 없다.",
        "_how": "/?edit 에서 각자 찍어 받은 파일을 tools/merge_doors.py 로 합쳤다.",
        "_sources": sources,
        "doors": kept,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    by_code = {}
    for d in kept:
        by_code[d["code"]] = by_code.get(d["code"], 0) + 1
    bl = json.loads((ROOT / "data" / "buildings.json").read_text(encoding="utf-8"))["buildings"]
    missing = [b["name"] for b in bl if b["code"] not in by_code]

    print(f"문 {len(kept)}개 · 건물 {len(by_code)}/{len(bl)}곳  → {out.relative_to(ROOT)}")
    if dropped:
        print(f"중복 {dropped}개 합침 ({SAME_DOOR:.0f}m 안은 같은 문으로 봄)")
    if missing:
        print(f"아직 안 찍은 건물 {len(missing)}곳: {', '.join(missing)}")
    print("\n이제 그래프를 다시 만드세요:  python3 tools/extract_paths.py /tmp/osm.xml")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
