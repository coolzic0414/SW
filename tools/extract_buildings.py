#!/usr/bin/env python3
"""OSM XML에서 캠퍼스 건물 폴리곤을 뽑아 data/buildings.json 으로 저장한다.

입력은 OSM API 0.6 map 응답(XML). 재다운로드 없이 캐시를 쓰려고 파일 경로를 받는다.
  python3 tools/extract_buildings.py /tmp/osm.xml
"""
import json, re, sys, statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OSM = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "osm-campus.xml")

codes = json.loads((ROOT / "data" / "room-codes.json").read_text(encoding="utf-8"))
# osm_name -> 건물 레코드
by_osm = {b["osm_name"]: b for b in codes["buildings"] if b["osm_name"]}

xml = OSM.read_text(encoding="utf-8")

# 1) 노드 좌표 수집
nodes = {}
for m in re.finditer(r'<node id="(\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"', xml):
    nodes[m.group(1)] = (float(m.group(2)), float(m.group(3)))

# 2) way 순회
out, unmatched = [], []
for w in re.finditer(r'<way id="(\d+)".*?</way>', xml, re.S):
    body, wid = w.group(0), w.group(1)
    tags = dict(re.findall(r'<tag k="([^"]+)" v="([^"]+)"', body))
    if "building" not in tags:
        continue
    name = tags.get("name")
    refs = re.findall(r'<nd ref="(\d+)"/>', body)
    pts = [nodes[r] for r in refs if r in nodes]
    if len(pts) < 3:
        continue
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    center = [round(statistics.fmean(p[0]) if False else statistics.fmean([q[0] for q in pts]), 7),
              round(statistics.fmean([q[1] for q in pts]), 7)]
    rec = {
        "osm_way_id": int(wid),
        "osm_name": name,
        "center": center,
        "polygon": [[round(a, 7), round(b, 7)] for a, b in pts],
    }
    b = by_osm.get(name) if name else None
    if b:
        rec.update({"code": b["code"], "name": b["name"], "aliases": b["aliases"]})
        out.append(rec)
    elif name:
        unmatched.append(rec)

# 강의실 코드는 없지만 출발지·도착지로 쓰는 건물 (기숙사·학생회관·식당 등)
lm_path = ROOT / "data" / "landmarks.json"
if lm_path.exists():
    wanted = {p["osm_name"]: p.get("aliases", [])
              for p in json.loads(lm_path.read_text(encoding="utf-8"))["places"]}
    for rec in unmatched:
        if rec["osm_name"] in wanted:
            out.append({**rec,
                        "code": "@" + rec["osm_name"],   # @ 로 시작하면 강의동이 아님
                        "name": rec["osm_name"],
                        "aliases": wanted[rec["osm_name"]],
                        "landmark": True})

# OSM에 없는 건물은 수동 파일에서 병합한다
manual_path = ROOT / "data" / "buildings-manual.json"
if manual_path.exists():
    have = {r["code"]: r for r in out}
    for m in json.loads(manual_path.read_text(encoding="utf-8"))["buildings"]:
        if m["code"] in have:
            # 이미 OSM 에서 찾은 건물이라도, 수동 폴리곤이 있으면 그걸 쓴다.
            # OSM 외곽선이 실제 건물보다 작은 경우가 있다(유니토피아관 등).
            if m.get("polygon"):
                have[m["code"]]["polygon"] = m["polygon"]
                have[m["code"]]["polygon_source"] = "traced"
            continue
        b = next((x for x in codes["buildings"] if x["code"] == m["code"]), None)
        out.append({
            "osm_way_id": None,
            "osm_name": None,
            "center": m["center"],
            "polygon": m.get("polygon", []),
            "code": m["code"],
            "name": m["name"],
            "aliases": b["aliases"] if b else [],
            "source": m.get("source", "estimated"),
        })

for r in out:
    r.setdefault("source", "osm")

out.sort(key=lambda r: (r.get("landmark", False), len(r["code"]), r["code"]))
missing = [b["code"] + " " + b["name"] for b in codes["buildings"]
           if b["code"] not in {r["code"] for r in out}]

(ROOT / "data" / "buildings.json").write_text(json.dumps({
    "_generated": "tools/extract_buildings.py",
    "_source": "OpenStreetMap (ODbL) — © OpenStreetMap contributors",
    "_bbox": "126.9215,36.7655,126.9345,36.7770",
    "buildings": out,
}, ensure_ascii=False, indent=2), encoding="utf-8")

lm = [r for r in out if r.get("landmark")]
print(f"매칭된 강의실 건물: {len(out)-len(lm)}/{len(codes['buildings'])} · 출발지 건물 {len(lm)}곳")
for r in out:
    tag = "  (출발지)" if r.get("landmark") else ""
    print(f"  {r['code']:>14}  {r['name']:<14} {r['center'][0]:.5f}, {r['center'][1]:.5f}  ({len(r['polygon'])}점){tag}")
print(f"\n누락: {', '.join(missing) if missing else '없음'}")
print(f"이름은 있으나 코드표에 없는 건물: {len(unmatched)}개 (상가·기숙사 등)")
