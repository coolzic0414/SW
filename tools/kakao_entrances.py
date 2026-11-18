#!/usr/bin/env python3
"""
kakao_entrances.mjs 가 찍은 타일에서 카카오 '출입구' 아이콘(문 + 화살표)을 찾아 좌표로 바꾼다.

아이콘은 거의 정확히 회색 161(r=g=b) 한 가지 색이고, 3배 화면에서 가로 24px · 세로 20px 정도다.
그 색의 덩어리를 모아 크기로 거르고, 확인용으로 후보를 한 장에 모아 저장한다(눈으로 본다).

    python3 tools/kakao_entrances.py
"""
import json
import os
import math
import sys
from pathlib import Path

OUT_DIR = Path(os.environ.get("OUT_DIR", "tmp"))  # 중간 산출물(스크린샷 등) 폴더. 레포에 안 올린다
S = OUT_DIR
# Pillow 가 시스템에 없으면 PYLIBS 에 설치 경로를 준다 (pip install --target)
if os.environ.get("PYLIBS"):
    sys.path.insert(0, os.environ["PYLIBS"])
from PIL import Image, ImageDraw  # noqa: E402

ENT = S / "ent"
ROOT = Path(__file__).resolve().parent.parent


def icon_pixels(im):
    px = im.load()
    W, H = im.size
    out = set()
    for y in range(H):
        for x in range(W):
            r, g, b = px[x, y]
            if abs(r - g) <= 3 and abs(g - b) <= 3 and 148 <= r <= 175:
                out.add((x, y))
    return out


def blobs(mask, link=14):
    """가까운 회색 점끼리 묶는다. 아이콘의 문틀과 화살표가 떨어져 있어서 넉넉히 잇는다."""
    seen, res = set(), []
    pts = sorted(mask)
    grid = {}
    for p in pts:
        grid.setdefault((p[0] // link, p[1] // link), []).append(p)
    for p in pts:
        if p in seen:
            continue
        st, b = [p], []
        seen.add(p)
        while st:
            x, y = st.pop()
            b.append((x, y))
            gx, gy = x // link, y // link
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for q in grid.get((gx + dx, gy + dy), ()):
                        if q not in seen and abs(q[0] - x) <= 3 and abs(q[1] - y) <= 3:
                            seen.add(q)
                            st.append(q)
        res.append(b)
    return res


def main():
    meta = json.loads((ENT / "meta.json").read_text())
    cands = []
    for t in meta:
        im = Image.open(ENT / t["file"]).convert("RGB")
        comps = [c for c in blobs(icon_pixels(im)) if len(c) >= 6]
        # 문틀(ㄷ)과 화살표가 따로 잡히므로, 중심이 가까운 조각끼리 합친다
        groups = []
        for c in comps:
            cx = sum(p[0] for p in c) / len(c)
            cy = sum(p[1] for p in c) / len(c)
            for g in groups:
                if abs(g["cx"] - cx) < 16 and abs(g["cy"] - cy) < 16:
                    g["pts"] += c
                    g["cx"] = sum(p[0] for p in g["pts"]) / len(g["pts"])
                    g["cy"] = sum(p[1] for p in g["pts"]) / len(g["pts"])
                    break
            else:
                groups.append({"pts": list(c), "cx": cx, "cy": cy})
        for g in groups:
            xs = [p[0] for p in g["pts"]]
            ys = [p[1] for p in g["pts"]]
            w, h = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
            if not (17 <= w <= 32 and 14 <= h <= 28 and 70 <= len(g["pts"]) <= 220):
                continue
            b = t["bounds"]
            # 아이콘 중심 → 좌표
            lat = b["n"] - (g["cy"] / t["h"]) * (b["n"] - b["s"])
            lon = b["w"] + (g["cx"] / t["w"]) * (b["e"] - b["w"])
            cands.append({"lat": lat, "lon": lon, "file": t["file"],
                          "box": [min(xs), min(ys), max(xs), max(ys)], "n": len(g["pts"])})

    # 타일이 겹치므로 같은 아이콘이 여러 번 잡힌다. 3m 안이면 하나로.
    uniq = []
    for c in cands:
        if any(math.hypot((c["lat"] - u["lat"]) * 111320, (c["lon"] - u["lon"]) * 89270) < 3 for u in uniq):
            continue
        uniq.append(c)

    # 확인용 모음 사진 — 후보마다 주변을 잘라 번호를 붙인다
    cell = 150
    cols = 8
    rows = (len(uniq) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, max(rows, 1) * cell), (255, 255, 255))
    dr = ImageDraw.Draw(sheet)
    for i, c in enumerate(uniq):
        im = Image.open(ENT / c["file"]).convert("RGB")
        x0, y0, x1, y1 = c["box"]
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        crop = im.crop((cx - 70, cy - 70, cx + 70, cy + 70)).resize((cell - 10, cell - 10))
        sheet.paste(crop, ((i % cols) * cell + 5, (i // cols) * cell + 5))
        dr.text(((i % cols) * cell + 8, (i // cols) * cell + 6), str(i), fill=(220, 0, 0))
    sheet.save(S / "ent-sheet.png")

    # 가장 가까운 건물
    bl = json.loads((ROOT / "data" / "buildings.json").read_text(encoding="utf-8"))["buildings"]

    def poly_dist(p, ring):
        K = 111320 * math.cos(math.radians(p[0]))
        best = 1e9
        for a, b in zip(ring, ring[1:] + ring[:1]):
            ax, ay = (a[1] - p[1]) * K, (a[0] - p[0]) * 111320
            bx, by = (b[1] - p[1]) * K, (b[0] - p[0]) * 111320
            dx, dy = bx - ax, by - ay
            t = max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1)))
            best = min(best, math.hypot(ax + dx * t, ay + dy * t))
        return best

    for i, c in enumerate(uniq):
        p = (c["lat"], c["lon"])
        near = sorted((poly_dist(p, b["polygon"]) if len(b.get("polygon") or []) >= 3 else
                       math.hypot((p[0] - b["center"][0]) * 111320, (p[1] - b["center"][1]) * 89270), b["code"], b["name"])
                      for b in bl)[0]
        c["building"], c["dist"] = near[1], round(near[0], 1)
        print(f"{i:>3} {c['lat']:.6f},{c['lon']:.6f}  {near[2]:<12} 외곽선에서 {near[0]:5.1f}m  ({c['file']})")
    (S / "ent-cands.json").write_text(json.dumps(uniq, ensure_ascii=False, indent=1))
    print(f"\n후보 {len(uniq)}개 → ent-sheet.png 로 눈으로 확인")


if __name__ == "__main__":
    main()
