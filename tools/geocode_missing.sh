#!/usr/bin/env bash
# OSM에 없는 건물의 좌표를 카카오 로컬 키워드 검색으로 받아온다.
#
# 카카오 REST 키가 따로 없어도 된다. JavaScript 키에 KA 헤더를 붙이면 통한다.
# KA 헤더의 origin 은 카카오 개발자센터의 JavaScript SDK 도메인과 같아야 한다.
#
#   ./tools/geocode_missing.sh "순천향대학교 BRIX관" "순천향대학교 멀티미디어관"
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
KEY=$(grep -E '^VITE_KAKAO_JS_KEY=' "$ENV_FILE" | cut -d= -f2-)
ORIGIN="http://localhost:5173"
# 캠퍼스 중심 — 동명이인 장소를 걸러내려고 반경을 건다
CX=126.93192
CY=36.77004

for q in "$@"; do
  echo "=== $q ==="
  curl -s --max-time 20 \
    -H "Authorization: KakaoAK ${KEY}" \
    -H "KA: sdk/1.0.0 os/javascript origin/${ORIGIN}" \
    -G --data-urlencode "query=${q}" \
       --data-urlencode "x=${CX}" --data-urlencode "y=${CY}" \
       --data-urlencode "radius=1500" --data-urlencode "size=5" \
    "https://dapi.kakao.com/v2/local/search/keyword.json" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
docs = d.get("documents", [])
for r in docs:
    name = r["place_name"]
    lat = float(r["y"])
    lon = float(r["x"])
    addr = r.get("road_address_name", "")
    print("  %-30s [%.6f, %.6f]  %s" % (name, lat, lon, addr))
if not docs:
    print("  결과 없음:", str(d)[:150])
'
done
