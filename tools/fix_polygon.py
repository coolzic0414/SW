#!/usr/bin/env python3
"""
door_review.mjs 이미지에서 읽은 지붕 모서리(이미지 픽셀)로 건물 외곽선을 고친다.
data/buildings-manual.json 에 덮어쓰기용으로 넣고 extract_buildings.py 를 다시 돌린다.

    python3 tools/fix_polygon.py 1 "500,612 590,545 905,950 840,1088" "사유"
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = Path(os.environ.get("OUT_DIR", "tmp"))  # 중간 산출물(스크린샷 등) 폴더. 레포에 안 올린다
META = OUT_DIR / "review" / "meta.json"


def main(code, pts, why):
    m = json.loads(META.read_text())[code]
    b = m["bounds"]
    ring = []
    for xy in pts.split():
        x, y = map(float, xy.split(","))
        ring.append([round(b["n"] - (y / m["h"]) * (b["n"] - b["s"]), 7),
                     round(b["w"] + (x / m["w"]) * (b["e"] - b["w"]), 7)])
    cen = [round(sum(p[0] for p in ring) / len(ring), 7), round(sum(p[1] for p in ring) / len(ring), 7)]
    f = ROOT / "data" / "buildings-manual.json"
    d = json.loads(f.read_text(encoding="utf-8"))
    old = next((x for x in d["buildings"] if x["code"] == code), None)
    name = old["name"] if old else m["name"]
    rest = {k: v for k, v in (old or {}).items() if k not in ("polygon", "center", "_polygon_source", "source")}
    d["buildings"] = [x for x in d["buildings"] if x["code"] != code]
    d["buildings"].append({**rest, "code": code, "name": name, "source": "satellite", "center": cen,
                           "polygon": ring, "_polygon_source": why})
    f.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    subprocess.run([sys.executable, str(ROOT / "tools" / "extract_buildings.py")], stdout=subprocess.DEVNULL)
    print(f"{name}: 외곽선 {len(ring)}점으로 교체")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "위성 지붕 모서리")
