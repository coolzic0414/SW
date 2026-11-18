#!/usr/bin/env python3
"""
missing_roads.mjs 가 찍은 두 장을 겹쳐, 지도엔 있는데 우리 그래프엔 없는 길을 표시한다.

카카오 지도는 도로를 무채색 회색(r=g=b)으로 칠하고, 캠퍼스 바닥·숲·건물은 푸른기를 섞는다.
그 차이로 도로 픽셀을 고르고, 그래프 마스크에 안 덮인 덩어리만 남긴다.

    python3 tools/missing_roads.py
"""
import json
import os
import sys
from pathlib import Path

OUT_DIR = Path(os.environ.get("OUT_DIR", "tmp"))  # 중간 산출물(스크린샷 등) 폴더. 레포에 안 올린다
S = OUT_DIR
if os.environ.get("PYLIBS"):
    sys.path.insert(0, os.environ["PYLIBS"])
from PIL import Image  # noqa: E402

NEUTRAL = 7        # |r-b| 가 이보다 작으면 무채색 = 도로
DARK, BRIGHT = 140, 240
MIN_BLOB = 150     # 이보다 작은 덩어리는 글자·횡단보도 같은 잡음
MIN_LONG = 60      # 덩어리의 긴 쪽이 이보다 짧으면 길이 아니라 모서리·얼룩이다


def main(tag=""):
    m = Image.open(S / f"mr-map{tag}.png").convert("RGB")
    k = Image.open(S / f"mr-mask{tag}.png").convert("L")
    meta = json.loads((S / f"mr-meta{tag}.json").read_text())
    W, H = m.size
    mp, kp = m.load(), k.load()

    # 1) 도로인데 우리 그래프가 안 덮은 픽셀
    miss = set()
    for y in range(H):
        for x in range(W):
            r, gg, b = mp[x, y]
            if abs(r - b) > NEUTRAL or abs(r - gg) > NEUTRAL:
                continue
            if not (DARK <= r <= BRIGHT):
                continue
            if kp[x, y] > 40:        # 마스크에 덮였다 = 아는 길
                continue
            miss.add((x, y))

    # 2) 덩어리로 묶는다. 한두 점짜리는 글자 테두리라 버린다.
    seen, blobs = set(), []
    for p in miss:
        if p in seen:
            continue
        stack, blob = [p], []
        seen.add(p)
        while stack:
            x, y = stack.pop()
            blob.append((x, y))
            for q in ((x+1, y), (x-1, y), (x, y+1), (x, y-1),
                      (x+1, y+1), (x-1, y-1), (x+1, y-1), (x-1, y+1)):
                if q in miss and q not in seen:
                    seen.add(q)
                    stack.append(q)
        if len(blob) < MIN_BLOB:
            continue
        xs = [q[0] for q in blob]
        ys = [q[1] for q in blob]
        if max(max(xs) - min(xs), max(ys) - min(ys)) < MIN_LONG:
            continue          # 길은 가늘고 길다. 뭉툭한 덩어리는 건물·주차장 모서리다.
        blobs.append(blob)

    blobs.sort(key=len, reverse=True)

    # 3) 지도 위에 분홍으로 덧칠해 눈으로 확인할 수 있게 한다
    out = m.copy()
    op = out.load()
    for blob in blobs:
        for x, y in blob:
            op[x, y] = (255, 0, 170)
    out.save(S / f"mr-missing{tag}.png")

    b = meta["bounds"]
    def to_ll(x, y):
        return (b["n"] - (y / H) * (b["n"] - b["s"]),
                b["w"] + (x / W) * (b["e"] - b["w"]))

    print(f"덮이지 않은 도로 덩어리 {len(blobs)}개  → mr-missing.png")
    for blob in blobs[:12]:
        xs = [p[0] for p in blob]
        ys = [p[1] for p in blob]
        a = to_ll(min(xs), min(ys))
        c = to_ll(max(xs), max(ys))
        print(f"  {len(blob):>5}px  위도 {c[0]:.5f}~{a[0]:.5f}  경도 {a[1]:.5f}~{c[1]:.5f}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
