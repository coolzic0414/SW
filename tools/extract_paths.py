#!/usr/bin/env python3
"""OSM XML에서 캠퍼스 보행 가능 경로를 뽑아 data/outdoor-graph.json 으로 저장한다.

캠퍼스 안의 service 도로는 대부분 보행도 가능한 통로라 포함한다.
primary/secondary(큰 찻길)는 캠퍼스를 가르는 도로라 제외한다 — 건너갈 수 없는 건 아니지만
횡단 지점을 모르는 상태로 이어붙이면 없는 길을 만들어낸다.
"""
import json
import math, re, statistics, sys
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OSM = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "osm-campus.xml")

# 실제로는 못 지나는데 OSM 에 그려진 길 (data/blocked-ways.json).
# 옹벽 위 관리로나 차단된 진입로 하나가 비탈을 가로지르면 경로가 통째로 거짓이 된다.
_blocked_file = ROOT / "data" / "blocked-ways.json"
BLOCKED_WAYS = {
    w["id"] for w in json.loads(_blocked_file.read_text(encoding="utf-8"))["ways"]
} if _blocked_file.exists() else set()

WALKABLE = {
    # 에스컬레이터는 서 있어도 올라가므로 평지보다 빠르게 잡는다.
    "escalator": 1.60,
    "footway": 1.30, "path": 1.25, "pedestrian": 1.30, "steps": 0.45,
    "living_street": 1.30, "service": 1.30, "residential": 1.25,
    "track": 1.15, "unclassified": 1.25,
}
CENTER = (36.77004, 126.93192)
RADIUS_M = 450  # 캠퍼스 반경. 앞 상권까지 끌어오지 않을 만큼

xml = OSM.read_text(encoding="utf-8")
K = math.cos(math.radians(CENTER[0])) * 111_000

def meters(a, b):
    return math.hypot((a[0] - b[0]) * 111_000, (a[1] - b[1]) * K)

nodes = {}
for m in re.finditer(r'<node id="(\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"', xml):
    nodes[m.group(1)] = (float(m.group(2)), float(m.group(3)))

# 1) 보행 가능 way 수집 + 각 노드가 몇 개 way에 쓰이는지 센다
use = defaultdict(int)
ways = []
blocked_hit = set()
for w in re.finditer(r'<way id="(\d+)".*?</way>', xml, re.S):
    body = w.group(0)
    tags = dict(re.findall(r'<tag k="([^"]+)" v="([^"]+)"', body))
    if w.group(1) in BLOCKED_WAYS:
        blocked_hit.add(w.group(1))
        continue          # 실제로는 못 지나는 길 (data/blocked-ways.json)
    hw = tags.get("highway")
    if hw not in WALKABLE:
        continue
    # access=no 는 보통 '차 못 들어감' 이다. foot=yes/designated 가 같이 붙어 있으면
    # 사람은 다닐 수 있다는 뜻이므로 버리면 안 된다.
    # (캠퍼스의 '걷고싶은 길' 이 이 조합이라, 이걸 버려서 지름길이 통째로 빠져 있었다)
    foot = tags.get("foot")
    if foot == "no":
        continue
    if tags.get("access") in ("private", "no") and foot not in ("yes", "designated", "permissive"):
        continue
    refs = [r for r in re.findall(r'<nd ref="(\d+)"/>', body) if r in nodes]
    refs = [r for r in refs if meters(nodes[r], CENTER) <= RADIUS_M]
    if len(refs) < 2:
        continue
    ways.append((w.group(1), hw, tags.get("name"), refs,
                 0.72 if tags.get("incline") == "steep" else 1.0))
    for r in refs:
        use[r] += 1

# 2) 교차점·끝점만 그래프 노드로 남기고 중간점은 거리로 접어넣는다
keep = {r for w in ways for r in (w[3][0], w[3][-1])} | {r for r, c in use.items() if c > 1}

edges = []
for wid, hw, name, refs, slope_f in ways:
    speed = WALKABLE[hw] * slope_f   # 가파르면 느리다 (incline=steep)
    seg_start, dist = refs[0], 0.0
    shape = [refs[0]]
    for a, b in zip(refs, refs[1:]):
        dist += meters(nodes[a], nodes[b])
        shape.append(b)
        if b in keep:
            if seg_start != b and dist > 0.5:
                edges.append({
                    "from": seg_start, "to": b, "kind": hw, "name": name,
                    "meters": round(dist, 1), "seconds": round(dist / speed, 1),
                    "indoor": False, "source": "osm",
                    # 접근로를 붙일 때 실제 길 모양에 투영해야 해서 중간점을 남긴다
                    "geom": [[round(nodes[r][0], 7), round(nodes[r][1], 7)] for r in shape],
                })
            seg_start, dist = b, 0.0
            shape = [b]

used_nodes = {e["from"] for e in edges} | {e["to"] for e in edges}
graph_nodes = {n: {"lat": round(nodes[n][0], 7), "lon": round(nodes[n][1], 7)} for n in used_nodes}

# 3) 연결성 — 가장 큰 덩어리에 몇 %가 들어가는지
adj = defaultdict(list)
for e in edges:
    adj[e["from"]].append(e["to"])
    adj[e["to"]].append(e["from"])

seen, comps = set(), []
for s in graph_nodes:
    if s in seen:
        continue
    q, comp = deque([s]), []
    seen.add(s)
    while q:
        u = q.popleft(); comp.append(u)
        for v in adj[u]:
            if v not in seen:
                seen.add(v); q.append(v)
    comps.append(comp)
comps.sort(key=len, reverse=True)
main = set(comps[0]) if comps else set()

# 4) 건물을 길에 붙인다
#
#    건물 중심에서 노드로 직선을 그으면 건물을 관통하는 선이 생긴다. 대신
#      (a) 길의 실제 모양(geom)에 투영해 가장 가까운 '길 위의 점'을 찾고
#      (b) 건물 외곽선에서 그 점에 가장 가까운 꼭짓점을 출입구 자리로 삼아
#    둘을 잇는다. 그 점이 엣지 중간이면 엣지를 둘로 쪼갠다.
#
#    자동 생성이라 실제 출입구가 아니다. source=auto 로 표시하고,
#    로드뷰로 확인한 건물부터 수동 좌표로 교체해 나간다.
blds = json.loads((ROOT / "data" / "buildings.json").read_text(encoding="utf-8"))["buildings"]


def point_in_ring(p, ring):
    x, y, inside = p[1], p[0], False
    for (a, b), (c, d) in zip(ring, ring[1:] + ring[:1]):
        if (a > y) != (c > y) and x < (d - b) * (y - a) / (c - a) + b:
            inside = not inside
    return inside


def crosses_building(pa, pb, end_margin=5.0):
    """두 점을 잇는 직선이 어느 건물 안을 지나가는가.
    양 끝 5m 는 봐준다 — 문이 오목한 자리(향설생활관1)에 있으면 선이 문 바로 옆 벽 끝을 스친다."""
    L = meters(pa, pb)
    if L < 2 * end_margin:
        return False
    n = max(4, int(L / 1.5))
    rings = [[tuple(q) for q in bb["polygon"]] for bb in blds if len(bb.get("polygon") or []) >= 3]
    for i in range(1, n):
        t = i / n
        if t * L < end_margin or (1 - t) * L < end_margin:
            continue
        q = (pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t)
        if any(point_in_ring(q, r) for r in rings):
            return True
    return False



def project(p, a, b):
    """선분 ab 위에서 점 p 에 가장 가까운 점과 t(0~1)."""
    ax, ay = (a[1] - p[1]) * K, (a[0] - p[0]) * 111_000
    bx, by = (b[1] - p[1]) * K, (b[0] - p[0]) * 111_000
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return a, 0.0, math.hypot(ax, ay)
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
    pt = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    return pt, t, meters(pt, p)

APPROACH_SPEED = 1.25
INDOOR_SPEED = 1.10      # 건물 안을 걷는 속도 (복도·문 통과 포함)
MAX_APPROACH = 90        # 이보다 먼 길에는 붙이지 않는다
DOORS_PER_BUILDING = 4   # 사방 중 최대 몇 군데에 출입 지점을 둘지

snaps, split_count = [], 0
surveyed_count = 0

def bearing_bucket(a, b, n=4):
    """a 에서 b 를 보는 방향을 n 등분한 번호. 같은 쪽에 문이 몰리는 걸 막는다."""
    dy = (b[0] - a[0]) * 111_000
    dx = (b[1] - a[1]) * K
    ang = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return int(ang // (360 / n))


def attach(edge, seg_i, road_pt, node_id):
    """길 위의 한 점을 그래프 노드로 만든다.

    엣지 끝과 거의 같은 자리면 그 끝을 재사용하고, 중간이면 엣지를 둘로 쪼갠다.
    쪼갤 때 길이는 실제 모양(geom)을 따라 다시 잰다.
    """
    global split_count
    for end_id in (edge["from"], edge["to"]):
        q = (graph_nodes[end_id]["lat"], graph_nodes[end_id]["lon"])
        if meters(q, road_pt) < 3:
            return end_id

    graph_nodes[node_id] = {"lat": round(road_pt[0], 7), "lon": round(road_pt[1], 7)}
    if edge not in edges:          # 이미 다른 문이 이 엣지를 쪼갰다면 노드만 남긴다
        return node_id

    g = edge["geom"]
    mid = [round(road_pt[0], 7), round(road_pt[1], 7)]
    head, tail = g[: seg_i + 1] + [mid], [mid] + g[seg_i + 1 :]

    def glen(pts):
        return sum(meters(tuple(pts[i]), tuple(pts[i + 1])) for i in range(len(pts) - 1))

    speed = WALKABLE.get(edge["kind"], 1.25)
    edges.remove(edge)
    for a_, b_, gg in ((edge["from"], node_id, head), (node_id, edge["to"], tail)):
        L = glen(gg)
        if L < 0.5:
            continue
        edges.append({**edge, "from": a_, "to": b_, "geom": gg,
                      "meters": round(L, 1), "seconds": round(L / speed, 1)})
    split_count += 1
    return node_id


# 문 노드 접두어: ds=직접 찍음, do=주소 기반, d=자동 추정
DOOR_PREFIXES = ("ds:", "do:", "d:")


def is_door_of(nid, code):
    return any(nid.startswith(f"{p}{code}:") for p in DOOR_PREFIXES)


# 재학생이 스카이뷰·로드뷰를 보며 직접 찍은 출입구. 이게 유일한 '진짜 문' 이다.
#   data/doors.json  ←  /?edit 도구에서 받은 파일들을 tools/merge_doors.py 로 합친 것
# 우선순위: 찍은 문 > 도로명주소 접근 지점 > 자동 추정
surveyed = {}
f_doors = ROOT / "data" / "doors.json"
if f_doors.exists():
    for d in json.loads(f_doors.read_text(encoding="utf-8"))["doors"]:
        surveyed.setdefault(d["code"], []).append(d)

# 도로명주소 기반 접근 지점(출입구 아님). 건물별로 모아둔다.
official = {}
f_official = ROOT / "data" / "access-points.json"
if f_official.exists():
    for d in json.loads(f_official.read_text(encoding="utf-8"))["access_points"]:
        official.setdefault(d["code"], []).append(d)

for b in blds:
    center = tuple(b["center"])
    ring = [tuple(q) for q in b["polygon"]] or [center]

    # (a) 모든 길에 투영해 후보를 모은다. 방향(동서남북)별로 가장 가까운 것만 남긴다.
    best_by_side = {}
    for e in list(edges):
        if e["kind"] in ("approach", "indoor"):
            continue
        g = e.get("geom") or [
            [graph_nodes[e["from"]]["lat"], graph_nodes[e["from"]]["lon"]],
            [graph_nodes[e["to"]]["lat"], graph_nodes[e["to"]]["lon"]],
        ]
        for i in range(len(g) - 1):
            pt, _t, d = project(center, tuple(g[i]), tuple(g[i + 1]))
            if d > MAX_APPROACH:
                continue
            side = bearing_bucket(center, pt, DOORS_PER_BUILDING)
            if side not in best_by_side or d < best_by_side[side][0]:
                best_by_side[side] = (d, e, i, pt)

    if not best_by_side:
        continue

    # (b) 건물 중심을 대표 노드로 두고, 각 방향의 문까지 '실내 보행'으로 잇는다.
    #     이러면 탐색기가 출발·도착 방향에 맞는 문을 알아서 고른다.
    hub = f"b:{b['code']}"
    graph_nodes[hub] = {"lat": round(center[0], 7), "lon": round(center[1], 7)}

    # (a-1) 주소 기반 접근 지점을 먼저 깐다. 출입구는 아니지만 건물 대표 지점이라
    #       자동 생성보다 신뢰도가 높다. 자동 지점은 비는 방향만 메운다.
    official_sides = set()

    # (a-0) 찍은 문. 실제 문이니 방향을 선점하고, 그 방향엔 추정 지점을 만들지 않는다.
    for k, sd in enumerate(surveyed.get(b["code"], [])):
        # 있는 문이지만 길찾기에는 안 쓰기로 한 문 (doors.json 의 routing_why 에 이유)
        if sd.get("routing") is False:
            continue
        at = tuple(sd["at"])
        # 문에서 길로 나가는 선은 건물을 가로지르면 안 된다. 가장 가까운 길이라도 건물 반대편이면
        # 문을 나가 벽을 뚫고 뒤로 가는 꼴이 된다(의료과학관 정문이 주차장 길에 붙었었다).
        cands = []
        for e in list(edges):
            if e["kind"] in ("approach", "indoor"):
                continue
            g = e.get("geom") or [
                [graph_nodes[e["from"]]["lat"], graph_nodes[e["from"]]["lon"]],
                [graph_nodes[e["to"]]["lat"], graph_nodes[e["to"]]["lon"]],
            ]
            for i in range(len(g) - 1):
                pt, _t, d = project(at, tuple(g[i]), tuple(g[i + 1]))
                cands.append((d, id(e), e, i, pt))
        cands.sort(key=lambda c: c[0])
        best = next(((d, e, i, pt) for d, _, e, i, pt in cands[:400]
                     if d <= MAX_APPROACH * 1.5 and not crosses_building(at, pt, end_margin=1.5)), None)
        if best is None and cands:
            d, _, e, i, pt = cands[0]
            best = (d, e, i, pt)
            print(f"  ! {b['code']} {sd.get('label', '')}: 건물을 안 가로지르고 닿는 길이 없어 가장 가까운 길에 붙인다")
        if best is None:
            print(f"  ! 찍은 문 건너뜀 ({b['code']} {sd.get('label','')}): 가까운 길이 없다")
            continue
        _d, edge, seg_i, road_pt = best
        official_sides.add(bearing_bucket(center, at, DOORS_PER_BUILDING))

        tag = f"{k}-{sd.get('label', '문')}"
        road_node = attach(edge, seg_i, road_pt, f"xs:{b['code']}:{tag}")
        door_id = f"ds:{b['code']}:{tag}"
        graph_nodes[door_id] = {"lat": round(at[0], 7), "lon": round(at[1], 7)}

        din = meters(center, at)
        edges.append({
            "from": hub, "to": door_id, "kind": "indoor", "name": None,
            "meters": round(din, 1), "seconds": round(max(din, 1) / INDOOR_SPEED, 1),
            "indoor": True, "source": "measured",
            "geom": [[round(center[0], 7), round(center[1], 7)], [round(at[0], 7), round(at[1], 7)]],
        })
        dout = meters(at, (graph_nodes[road_node]["lat"], graph_nodes[road_node]["lon"]))
        rec = {
            "from": door_id, "to": road_node, "kind": "approach", "name": sd.get("label"),
            "meters": round(dout, 1), "seconds": round(max(dout, 1) / APPROACH_SPEED, 1),
            "indoor": False, "source": "measured",
            "geom": [[round(at[0], 7), round(at[1], 7)],
                     [graph_nodes[road_node]["lat"], graph_nodes[road_node]["lon"]]],
        }
        if sd.get("accessible"):
            rec["accessible"] = True
        edges.append(rec)
        surveyed_count += 1

    # 문을 직접 확인한 건물은 주소 기준점(건물 안쪽)이나 자동 추정 문을 더하지 않는다.
    # 남는 면을 추정으로 채우면 옹벽·주차장 너머로 가짜 문이 생겨 경로가 그리로 샌다.
    has_surveyed = bool(surveyed.get(b["code"]))
    for od in ([] if has_surveyed else official.get(b["code"], [])):
        at = tuple(od["at"])
        # 이 출입구에서 가장 가까운 길 위의 점
        best = None
        for e in list(edges):
            if e["kind"] in ("approach", "indoor"):
                continue
            g = e.get("geom") or [
                [graph_nodes[e["from"]]["lat"], graph_nodes[e["from"]]["lon"]],
                [graph_nodes[e["to"]]["lat"], graph_nodes[e["to"]]["lon"]],
            ]
            for i in range(len(g) - 1):
                pt, _t, d = project(at, tuple(g[i]), tuple(g[i + 1]))
                if best is None or d < best[0]:
                    best = (d, e, i, pt)
        if best is None:
            continue
        if bearing_bucket(center, at, DOORS_PER_BUILDING) in official_sides:
            continue   # 그 방향엔 찍은 문이 이미 있다
        _d, edge, seg_i, road_pt = best
        official_sides.add(bearing_bucket(center, at, DOORS_PER_BUILDING))

        road_node = attach(edge, seg_i, road_pt, f"xo:{b['code']}:{od['address']}")
        door_id = f"do:{b['code']}:{od['address']}"
        graph_nodes[door_id] = {"lat": round(at[0], 7), "lon": round(at[1], 7)}

        din = meters(center, at)
        edges.append({
            "from": hub, "to": door_id, "kind": "indoor", "name": None,
            "meters": round(din, 1), "seconds": round(max(din, 1) / INDOOR_SPEED, 1),
            "indoor": True, "source": "address",
            "geom": [[round(center[0], 7), round(center[1], 7)], [round(at[0], 7), round(at[1], 7)]],
        })
        dout = meters(at, (graph_nodes[road_node]["lat"], graph_nodes[road_node]["lon"]))
        edges.append({
            "from": door_id, "to": road_node, "kind": "approach", "name": od["address"],
            "meters": round(dout, 1), "seconds": round(max(dout, 1) / APPROACH_SPEED, 1),
            "indoor": False, "source": "address",
            "geom": [[round(at[0], 7), round(at[1], 7)],
                     [graph_nodes[road_node]["lat"], graph_nodes[road_node]["lon"]]],
        })

    for side, (_d, edge, seg_i, road_pt) in sorted(best_by_side.items()):
        if has_surveyed:
            continue
        if side in official_sides:
            continue   # 그 방향엔 주소 기반 지점이 이미 있다
        if edge not in edges:   # 앞선 문이 이 엣지를 이미 쪼갰으면 건너뛴다
            continue
        # 꼭짓점이 아니라 '변 위의 가장 가까운 점'을 문으로 삼는다.
        # 꼭짓점을 쓰면 사각형 건물에서 문이 모서리에 박혀 어색하다.
        door = ring[0]
        best_d = float("inf")
        for i in range(len(ring)):
            pt_on_edge, _t, dd = project(road_pt, ring[i], ring[(i + 1) % len(ring)])
            if dd < best_d:
                best_d, door = dd, pt_on_edge
        road_node = attach(edge, seg_i, road_pt, f"x:{b['code']}:{side}")

        door_id = f"d:{b['code']}:{side}"
        graph_nodes[door_id] = {"lat": round(door[0], 7), "lon": round(door[1], 7)}

        # 건물 안을 걸어 그 문까지 가는 비용. 실내라서 비 올 때 가중치에도 쓰인다.
        din = meters(center, door)
        edges.append({
            "from": hub, "to": door_id, "kind": "indoor", "name": None,
            "meters": round(din, 1), "seconds": round(max(din, 1) / INDOOR_SPEED, 1),
            "indoor": True, "source": "auto",
            "geom": [[round(center[0], 7), round(center[1], 7)], [round(door[0], 7), round(door[1], 7)]],
        })

        # 문에서 길까지
        dout = meters(door, (graph_nodes[road_node]["lat"], graph_nodes[road_node]["lon"]))
        edges.append({
            "from": door_id, "to": road_node, "kind": "approach", "name": None,
            "meters": round(dout, 1), "seconds": round(max(dout, 1) / APPROACH_SPEED, 1),
            "indoor": False, "source": "auto",
            "geom": [[round(door[0], 7), round(door[1], 7)],
                     [graph_nodes[road_node]["lat"], graph_nodes[road_node]["lon"]]],
        })

    doors = len(best_by_side)
    nearest = min(best_by_side.values(), key=lambda v: v[0])[0]
    snaps.append({"code": b["code"], "name": b["name"], "node": hub,
                  "doors": doors, "approach_meters": round(nearest, 1),
                  "in_main_component": True})

# 4.4) 위성·재학생 확인으로 넣는 보행로 (OSM 에 없는 길)
#
#      건물 접근점이 만들어진 뒤에 돌려야 한다 — 길 위에 새로 생긴 점(x:, xo:)에도
#      붙을 수 있어야 끊기지 않는다.
#
#      끝점이 기존 길과 가까우면 그 노드에 붙여서 그래프가 끊기지 않게 한다.
manual_paths = ROOT / "data" / "paths-manual.json"
if manual_paths.exists():
    MANUAL_SNAP = 35       # 수동 보행로 양 끝을 기존 길에 붙이는 허용 거리
    DOWNHILL_FACTOR = 1.25  # 내리막은 이만큼 빠르다
    UPHILL_FACTOR = 0.70    # 오르막은 이만큼 느리다

    SPLIT_LIMIT = 20.0   # 이보다 먼 도로 선에는 붙이지 않는다

    def split_nearest_edge(pt, nid):
        """pt 에서 가장 가까운 도로 선(문 접근로·건물 안·관통 제외)을 그 지점에서 둘로 나눈다. 새 점 id 를 돌려준다."""
        mlon = 111320 * math.cos(math.radians(pt[0]))
        best = None
        for ei, e in enumerate(edges):
            if e.get("kind") in ("approach", "indoor", "through_building"):
                continue
            a_, b_ = graph_nodes[e["from"]], graph_nodes[e["to"]]
            geom = e.get("geom") or [[a_["lat"], a_["lon"]], [b_["lat"], b_["lon"]]]
            # geom 이 from→to 방향인지 맞춘다
            if meters(tuple(geom[0]), (a_["lat"], a_["lon"])) > meters(tuple(geom[-1]), (a_["lat"], a_["lon"])):
                geom = list(reversed(geom))
            for k in range(len(geom) - 1):
                ax, ay = (geom[k][1] - pt[1]) * mlon, (geom[k][0] - pt[0]) * 111320
                bx, by = (geom[k + 1][1] - pt[1]) * mlon, (geom[k + 1][0] - pt[0]) * 111320
                dx, dy = bx - ax, by - ay
                t = max(0.0, min(1.0, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) or 1)))
                d = math.hypot(ax + dx * t, ay + dy * t)
                if best is None or d < best[0]:
                    best = (d, ei, k, t, geom)
        if best is None or best[0] > SPLIT_LIMIT:
            raise SystemExit(f"  ! {nid}: {SPLIT_LIMIT}m 안에 나눌 도로 선이 없습니다")
        d, ei, k, t, geom = best
        e = edges[ei]
        p = (geom[k][0] + (geom[k + 1][0] - geom[k][0]) * t, geom[k][1] + (geom[k + 1][1] - geom[k][1]) * t)
        p = (round(p[0], 7), round(p[1], 7))
        g1 = [list(x) for x in geom[: k + 1]] + [list(p)]
        g2 = [list(p)] + [list(x) for x in geom[k + 1 :]]
        L = lambda g: sum(meters(tuple(g[j]), tuple(g[j + 1])) for j in range(len(g) - 1))
        l1, l2 = L(g1), L(g2)
        tot = max(l1 + l2, 0.1)
        graph_nodes[nid] = {"lat": p[0], "lon": p[1]}
        e1 = {**e, "to": nid, "meters": round(e["meters"] * l1 / tot, 1), "seconds": round(e["seconds"] * l1 / tot, 1), "geom": g1}
        e2 = {**e, "from": nid, "meters": round(e["meters"] * l2 / tot, 1), "seconds": round(e["seconds"] * l2 / tot, 1), "geom": g2}
        edges[ei:ei + 1] = [e1, e2]
        print(f"  {nid}: 도로 선을 {d:.1f}m 거리에서 나눠 붙임 ({e['from']}–{e['to']})")
        return nid

    def nearest_node(pt, limit=MANUAL_SNAP):
        """
        수동 보행로의 끝을 붙일 점을 고른다.

        먼저 '진짜 길 위의 점' 에서 찾고, 없을 때만 다른 수동 보행로의 점을 본다.
        둘을 같이 놓고 가까운 것을 고르면, 손으로 넣은 길끼리 한가운데서 엉겨붙어
        경로가 계단을 타다 옆길로 갈아타는 식으로 이상하게 꺾인다.
        """
        road, manual = (None, limit), (None, limit)
        for n, q in graph_nodes.items():
            # 건물 대표점(b:)과 모든 문(ds:/do:/d:) 말고, 길 위의 점에만 붙인다.
            # ds: 를 빼먹으면 계단이 엉뚱하게 '남의 건물 측문'에서 시작한다.
            if n.startswith(("b:",) + DOOR_PREFIXES):
                continue
            d = meters((q["lat"], q["lon"]), pt)
            slot = "manual" if n.startswith("mp:") else "road"
            if slot == "road" and d < road[1]:
                road = (n, d)
            elif slot == "manual" and d < manual[1]:
                manual = (n, d)
        return road[0] if road[0] else manual[0]

    for mp in json.loads(manual_paths.read_text(encoding="utf-8"))["paths"]:
        pts = [tuple(q) for q in mp["points"]]
        speed = WALKABLE.get(mp.get("kind", "footway"), 1.30)
        # 양 끝을 먼저 정한다. 중간 점을 먼저 만들면 끝점이 '방금 만든 자기 점' 에 붙어
        # 길이 막다른 토막이 된다. (실제로 그렇게 들어간 적이 있다)
        def snap_end(i):
            q = pts[i]
            # 끝을 어디에 붙일지 직접 정할 수 있다 (start_at / end_at).
            #   "free"      : 아무 데도 붙이지 않고 제 점으로 둔다. 운동장 안쪽 끝처럼 근처 도로(위쪽)에
            #                 붙으면 계단 아래가 도로로 순간이동하는 곳에 쓴다.
            #   "mp:이름:번호" : 먼저 적은 다른 손 길의 그 점에 붙인다. 계단과 가로지르기를 정확히 잇는다.
            at = mp.get("start_at" if i == 0 else "end_at")
            if at == "free":
                nid = f"mp:{mp['name']}:{i}"
                graph_nodes[nid] = {"lat": round(q[0], 7), "lon": round(q[1], 7)}
                return nid
            if at == "split":
                # 가장 가까운 '도로 선' 을 그 자리에서 둘로 나누고 거기에 붙인다.
                # 교차점에만 붙이면, 긴 도로 한가운데로 내려오는 계단이 수십 m 떨어진 교차점까지 이어져 버린다.
                return split_nearest_edge(q, f"j:{mp['name']}:{i}")
            if at:
                if at not in graph_nodes:
                    raise SystemExit(f"'{mp['name']}' 의 {'start_at' if i == 0 else 'end_at'}={at} 점이 없습니다 — 그 길을 이 길보다 먼저 적어야 합니다")
                return at
            nid = nearest_node(q)
            if nid is not None:
                return nid
            print(f"  ! '{mp['name']}' 끝점이 기존 길에서 {MANUAL_SNAP}m 안에 없습니다 "
                  f"({q[0]:.5f},{q[1]:.5f}) — 끊긴 채로 들어갑니다")
            nid = f"mp:{mp['name']}:{i}"
            graph_nodes[nid] = {"lat": round(q[0], 7), "lon": round(q[1], 7)}
            return nid

        last = len(pts) - 1
        ids = [None] * len(pts)
        ids[0], ids[last] = snap_end(0), snap_end(last)
        for i in range(1, last):
            nid = f"mp:{mp['name']}:{i}"
            graph_nodes[nid] = {"lat": round(pts[i][0], 7), "lon": round(pts[i][1], 7)}
            ids[i] = nid

        # 붙은 지점이 내가 찍은 끝점에서 떨어져 있으면, 그 사이를 잇는 선을 따로 넣는다.
        # 안 그리면 경로가 그만큼 순간이동해서 '산을 가로지르는' 것처럼 보이고,
        # 거리·시간에서도 그 구간이 공짜가 된다.
        CONNECT_MIN = 1.0
        for end_i in (0, last):
            n = graph_nodes[ids[end_i]]
            gap = meters((n["lat"], n["lon"]), pts[end_i])
            if gap < CONNECT_MIN:
                continue
            own = f"mp:{mp['name']}:{end_i}"
            graph_nodes[own] = {"lat": round(pts[end_i][0], 7), "lon": round(pts[end_i][1], 7)}
            snapped = ids[end_i]
            ids[end_i] = own
            link_pts = [(n["lat"], n["lon"]), pts[end_i]]
            if end_i == last:
                link_pts.reverse()
            edges.append({
                "from": snapped if end_i == 0 else own,
                "to": own if end_i == 0 else snapped,
                "kind": "footway", "name": f"{mp['name']} 연결",
                "meters": round(gap, 1), "seconds": round(gap / 1.30, 1),
                "indoor": False, "source": mp.get("source", "satellite"),
                "accessible": True,
                "geom": [[round(q[0], 7), round(q[1], 7)] for q in link_pts],
            })
        # 길 한가운데가 기존 도로를 스치면 거기서도 갈아탈 수 있어야 한다.
        # 양 끝만 이어두면 중간에서 만나는 길을 못 쓰고 끝까지 돌아갔다 와야 한다.
        MIDWAY_JOIN = 10.0
        for i in range(1, last):
            here = graph_nodes[ids[i]]
            best = None
            for nid, q in graph_nodes.items():
                if nid.startswith(("b:", "mp:") + DOOR_PREFIXES):
                    continue
                dd = meters((q["lat"], q["lon"]), (here["lat"], here["lon"]))
                if dd < MIDWAY_JOIN and (best is None or dd < best[1]):
                    best = (nid, dd)
            if best is None:
                continue
            nid, dd = best
            q = graph_nodes[nid]
            edges.append({
                "from": ids[i], "to": nid, "kind": "footway",
                "name": f"{mp['name']} 갈림",
                "meters": round(max(dd, 1.0), 1),
                "seconds": round(max(dd, 1.0) / 1.30, 1),
                "indoor": False, "source": mp.get("source", "satellite"), "accessible": True,
                "geom": [[here["lat"], here["lon"]], [q["lat"], q["lon"]]],
            })

        # 비탈은 오르내리는 시간이 다르다. lower_end 가 적힌 길은 방향별로 따로 깐다.
        #   내려갈 때   빠르다 (계단도 성큼성큼)
        #   올라갈 때   느리다 (숨이 찬다)
        # 고도 데이터가 없어서 '어느 쪽이 아래인지' 는 재학생이 알려준 것만 쓴다.
        lower = mp.get("lower_end")        # "start" | "end" | 없음(평지)
        down_f, up_f = (DOWNHILL_FACTOR, UPHILL_FACTOR) if lower else (1.0, 1.0)
        # 계단의 기본 속도(0.45m/s)는 이미 '계단을 오르는 속도' 다 (OSM 계단도 양방향 이 값).
        # 여기에 오르막 감속을 또 곱하면 0.31m/s 가 되어, 같은 언덕을 오르는 걷고싶은 길(0.94m/s)보다
        # 세 배 느리다고 계산한다. 그래서 미랩 → BRIX 가 산길 계단 대신 160m 먼 우회로를 골랐다.
        # 계단은 내려갈 때 빨라지는 것만 반영한다.
        if mp.get("kind") == "steps":
            up_f = 1.0

        for a_, b_, pa, pb in zip(ids, ids[1:], pts, pts[1:]):
            L = meters(pa, pb)
            if L < 0.5:
                continue
            base = {
                "kind": mp.get("kind", "footway"), "name": mp["name"],
                "meters": round(L, 1), "indoor": False,
                "source": mp.get("source", "satellite"),
            }
            if "accessible" in mp:
                base["accessible"] = mp["accessible"]
            geom_fwd = [[round(pa[0], 7), round(pa[1], 7)], [round(pb[0], 7), round(pb[1], 7)]]

            if not lower:
                rec = {**base, "from": a_, "to": b_,
                       "seconds": round(L / speed, 1), "geom": geom_fwd}
                if mp.get("oneway"):
                    rec["oneway"] = True
                edges.append(rec)
                continue

            # points 를 적은 순서가 start→end 다. lower_end 가 "end" 면 앞으로 갈수록 내려간다.
            fwd_is_down = lower == "end"
            edges.append({**base, "from": a_, "to": b_, "oneway": True,
                          "seconds": round(L / (speed * (down_f if fwd_is_down else up_f)), 1),
                          "geom": geom_fwd})
            if not mp.get("oneway"):
                edges.append({**base, "from": b_, "to": a_, "oneway": True,
                              "seconds": round(L / (speed * (up_f if fwd_is_down else down_f)), 1),
                              "geom": list(reversed(geom_fwd))})

# 4.5) 건물 관통 지름길 (data/shortcuts.json)
#
#      건물 허브는 통과로로 못 쓰게 막아뒀다(graph.ts). 실제로 지나갈 수 있는 건물만
#      여기서 두 접근 지점을 직접 이어 준다.
INDOOR_SPEED_THROUGH = 1.05   # 복도·문·사람 때문에 바깥보다 느리다
FLOOR_DOWN_SECONDS = 10       # 한 층 내려가기 — 계단은 금방이다
FLOOR_UP_SECONDS = 22         # 한 층 올라가기 — 내려가는 것보다 두 배 넘게 든다

shortcuts_file = ROOT / "data" / "shortcuts.json"
shortcut_count = 0
if shortcuts_file.exists():
    # 참조 건물(이웃)의 중심 좌표 — OSM 이름으로 찾는다
    neighbour = {}
    for w in re.finditer(r'<way id="(\d+)".*?</way>', xml, re.S):
        t = dict(re.findall(r'<tag k="([^"]+)" v="([^"]+)"', w.group(0)))
        if "building" not in t or not t.get("name"):
            continue
        pts = [nodes[r] for r in re.findall(r'<nd ref="(\d+)"/>', w.group(0)) if r in nodes]
        if len(pts) >= 3:
            neighbour[t["name"]] = (statistics.fmean(p[0] for p in pts),
                                    statistics.fmean(p[1] for p in pts))

    def ranked_doors(code, target_name, centre):
        """그 건물의 접근 지점을 target 건물 방향에 가까운 순서로."""
        tgt = neighbour.get(target_name)
        if tgt is None:
            return None
        want = math.atan2((tgt[1] - centre[1]) * K, (tgt[0] - centre[0]) * 111_000)
        out = []
        for nid, n in graph_nodes.items():
            if not is_door_of(nid, code):
                continue
            have = math.atan2((n["lon"] - centre[1]) * K, (n["lat"] - centre[0]) * 111_000)
            out.append((abs((math.degrees(have - want) + 180) % 360 - 180), nid))
        return sorted(out)

    def door_pair(code, from_name, to_name, centre):
        """양쪽 방향에 맞는 '서로 다른' 문 두 개를 고른다.

        두 이웃 건물이 비슷한 방향에 있으면 1순위가 겹친다. 그대로 두면
        지름길이 조용히 사라지므로, 겹치지 않는 조합 중 방향 오차 합이 가장 작은 것을 쓴다.
        """
        A = ranked_doors(code, from_name, centre)
        B = ranked_doors(code, to_name, centre)
        if A is None:
            return None, None, f"'{from_name}' 건물을 OSM 에서 못 찾음"
        if B is None:
            return None, None, f"'{to_name}' 건물을 OSM 에서 못 찾음"
        if len(A) < 2:
            return None, None, "접근 지점이 두 개 이상 필요하다"
        # 관통은 건물의 '반대편'을 이어야 한다. 같은 면의 두 점을 고르면
        # 건물을 가로지르는 게 아니라 벽을 따라 옆으로 가는 꼴이 된다.
        def sep(a, b):
            pa, pb = graph_nodes[a], graph_nodes[b]
            ba = math.atan2((pa["lon"] - centre[1]) * K, (pa["lat"] - centre[0]) * 111_000)
            bb = math.atan2((pb["lon"] - centre[1]) * K, (pb["lat"] - centre[0]) * 111_000)
            return abs((math.degrees(ba - bb) + 180) % 360 - 180)

        MIN_SEPARATION = 100   # 두 문이 중심에서 보아 이 각도 이상 떨어져야 한다
        best = min(
            ((da + db, a, b) for da, a in A for db, b in B
             if a != b and sep(a, b) >= MIN_SEPARATION),
            default=None,
        )
        if best is None:
            return None, None, (f"서로 반대편({MIN_SEPARATION}° 이상 떨어진) 접근 지점 쌍이 없음 "
                                f"— 건물 폴리곤이 거칠거나 한쪽에만 문이 잡혔을 수 있다")
        return best[1], best[2], None

    centres = {b["code"]: tuple(b["center"]) for b in blds}
    for sc in json.loads(shortcuts_file.read_text(encoding="utf-8"))["shortcuts"]:
        code = sc["building"]
        centre = centres.get(code)
        if centre is None:
            print(f"  ! 지름길 건너뜀: 건물 코드 {code} 없음")
            continue
        # 문을 직접 찍은 뒤로는 이름으로 지정할 수 있다. 방향으로 추측하면
        # '반대편이어야 한다' 같은 규칙이 실제 동선(남문→서문처럼 90°)을 거부해 버린다.
        if sc.get("from_door") and sc.get("to_door"):
            def door_by_label(lbl):
                hit = [n for n in graph_nodes if n.startswith(f"ds:{code}:") and n.endswith(f"-{lbl}")]
                return hit[0] if hit else None
            a, b_ = door_by_label(sc["from_door"]), door_by_label(sc["to_door"])
            err = None if a and b_ else f"찍은 문 '{sc['from_door']}'/'{sc['to_door']}' 을 못 찾음"
        else:
            a, b_, err = door_pair(code, sc["from_toward"], sc["to_toward"], centre)
        if err:
            print(f"  ! 지름길 건너뜀 ({sc['name']}): {err}")
            continue
        pa = (graph_nodes[a]["lat"], graph_nodes[a]["lon"])
        pb = (graph_nodes[b_]["lat"], graph_nodes[b_]["lon"])
        L = meters(pa, pb)
        flat = L / INDOOR_SPEED_THROUGH
        floors = abs(sc.get("floors", 0))
        # 같은 통로라도 내려가는 쪽이 훨씬 빠르다. 방향별로 나눠서 넣는다.
        # floors 는 from → to 방향으로 '내려가는' 층수로 본다.
        for frm, to, per_floor, way in (
            (a, b_, FLOOR_DOWN_SECONDS, "내려감"),
            (b_, a, FLOOR_UP_SECONDS, "올라감"),
        ):
            rec = {
                "from": frm, "to": to, "kind": "through_building",
                "name": f"{sc['name']} ({way})" if floors else sc["name"],
                "meters": round(L, 1),
                "seconds": round(flat + floors * per_floor, 1),
                "indoor": True, "oneway": True,
                "source": sc.get("source", "knowledge"),
                "geom": [[round(graph_nodes[frm]["lat"], 7), round(graph_nodes[frm]["lon"], 7)],
                         [round(graph_nodes[to]["lat"], 7), round(graph_nodes[to]["lon"], 7)]],
            }
            if "accessible" in sc:
                rec["accessible"] = sc["accessible"]
            edges.append(rec)
        shortcut_count += 1

def route_around(pa, pb, max_ratio=1.8, push=2.5):
    """광장·주차장을 건너는 길. 직선이 건물을 스치면 건물 모서리를 바깥으로 살짝 띄운 점을 거쳐 돈다.

    모서리 점들로 '서로 보이는 점끼리 잇는' 그래프를 만들고 최단 경로를 찾는다.
    직선보다 max_ratio 배 넘게 길어지면 광장으로 이어진 게 아니라고 보고 포기한다.
    """
    if not crosses_building(pa, pb):
        return [pa, pb]
    L = meters(pa, pb)
    mid = ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)
    pts = [pa, pb]
    for bb in blds:
        ring = [tuple(q) for q in (bb.get("polygon") or [])]
        if len(ring) < 3 or min(meters(q, mid) for q in ring) > L:
            continue
        cx = sum(q[0] for q in ring) / len(ring)
        cy = sum(q[1] for q in ring) / len(ring)
        for q in ring:
            d = meters(q, (cx, cy)) or 1
            f = (d + push) / d
            pts.append((cx + (q[0] - cx) * f, cy + (q[1] - cy) * f))
    n = len(pts)
    dist = [float("inf")] * n
    prev = [None] * n
    dist[0] = 0.0
    done = [False] * n
    for _ in range(n):
        u = min((i for i in range(n) if not done[i]), key=lambda i: dist[i], default=None)
        if u is None or dist[u] == float("inf"):
            break
        done[u] = True
        if u == 1:
            break
        for v in range(n):
            if done[v] or v == u:
                continue
            w = meters(pts[u], pts[v])
            if dist[u] + w < dist[v] and not crosses_building(pts[u], pts[v], end_margin=0.5 if u > 1 and v > 1 else 5.0):
                dist[v] = dist[u] + w
                prev[v] = u
    if dist[1] == float("inf") or dist[1] > L * max_ratio:
        return None
    path, i = [], 1
    while i is not None:
        path.append(pts[i])
        i = prev[i]
    return list(reversed(path))


# 4.6) 건물 사이 직통 구간 (data/connections.json)
#
#      주차장·광장처럼 포장면으로 이어졌지만 길로 안 그려진 곳. 두 건물의 접근 지점 중
#      서로 가장 가까운 쌍을 직선으로 잇는다 — 좌표를 손으로 적지 않아도 된다.
conn_file = ROOT / "data" / "connections.json"
conn_count = 0
if conn_file.exists():
    def doors_of(code):
        return [(nid, (n["lat"], n["lon"])) for nid, n in graph_nodes.items()
                if is_door_of(nid, code)]

    for c in json.loads(conn_file.read_text(encoding="utf-8"))["connections"]:
        A, B = doors_of(c["a"]), doors_of(c["b"])
        if not A or not B:
            print(f"  ! 직통 건너뜀 ({c['a']} ↔ {c['b']}): 접근 지점이 없음")
            continue
        # 가장 가까운 문 쌍이라도 그 직선이 건물을 뚫고 지나가면 쓸 수 없다.
        # (공학관처럼 한쪽 면에만 문이 있으면 반대편 건물로 가는 선이 건물 안을 가로지른다)
        # 문 쌍마다 광장을 건너는 길(필요하면 건물 모서리를 돌아서)을 찾아 가장 짧은 것을 쓴다.
        best = None
        for na, pa in A:
            for nb, pb in B:
                line = route_around(pa, pb)
                if line is None:
                    continue
                Ld = sum(meters(x, y) for x, y in zip(line, line[1:]))
                if best is None or Ld < best[0]:
                    best = (Ld, na, nb, line)
        if best is None:
            print(f"  ! 직통 건너뜀 ({c['a']} ↔ {c['b']}): 건물을 피해 돌아가는 길도 직선의 1.8배를 넘는다")
            continue
        d_, na, nb, line = best
        speed = WALKABLE.get(c.get("kind", "footway"), 1.30)
        rec = {
            "from": na, "to": nb, "kind": c.get("kind", "footway"),
            "name": f"{c['a']} ↔ {c['b']} 직통",
            "meters": round(d_, 1), "seconds": round(d_ / speed, 1),
            "indoor": False, "source": "knowledge",
            "geom": [[round(q[0], 7), round(q[1], 7)] for q in line],
        }
        if "accessible" in c:
            rec["accessible"] = c["accessible"]
        edges.append(rec)
        conn_count += 1

# 4.7) 바깥 경사로 (data/slopes.json)
#
#      건물 관통은 층마다 시간을 받는데 바깥 길은 전부 평지로 계산되면,
#      같은 높이를 내려가는 바깥 우회로가 공짜가 되어 관통보다 빨라 보인다.
#      경사로로 등록된 OSM 길은 방향별로 나눠 급경사 속도 + 층 비용을 매긴다.
#      (접근로 붙이기·지름길까지 끝난 뒤에 해야 엣지가 쪼개져도 빠짐없이 적용된다)
slope_file = ROOT / "data" / "slopes.json"
slope_count = 0
STEEP_FACTOR = 0.72        # OSM incline=steep 과 같은 값
SLOPE_TOL = 4.0            # 이 선에서 몇 m 안에 있는 길까지 경사로로 본다
if slope_file.exists():
    def seg_dist(p, a, b):
        ax, ay = (a[1] - p[1]) * K, (a[0] - p[0]) * 111_000
        bx, by = (b[1] - p[1]) * K, (b[0] - p[0]) * 111_000
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1)))
        return math.hypot(ax + dx * t, ay + dy * t), t

    def along(p, line):
        """선 위로 투영했을 때 위쪽 끝에서부터의 거리(m)와 선까지의 거리."""
        best, acc, pos = (1e9, 0.0), 0.0, 0.0
        for a, b in zip(line, line[1:]):
            L = meters(a, b)
            d, t = seg_dist(p, a, b)
            if d < best[0]:
                best, pos = (d, 0.0), acc + t * L
            acc += L
        return pos, best[0], acc

    for sl in json.loads(slope_file.read_text(encoding="utf-8"))["slopes"]:
        line = [tuple(q) for q in sl["line"]]
        floors = sl.get("floors", 0)
        f = STEEP_FACTOR if sl.get("steep") else 1.0
        new_edges, hit = [], 0
        for e in edges:
            if e.get("source") != "osm" or e.get("oneway"):
                new_edges.append(e)
                continue
            geom = e.get("geom") or []
            info = [along(tuple(q), line) for q in geom]
            if not geom or any(d > SLOPE_TOL for _, d, _ in info):
                new_edges.append(e)
                continue
            total = info[0][2]
            drop = abs(info[-1][0] - info[0][0]) / total if total else 0   # 이 엣지가 맡는 높이 비율
            fwd_down = info[-1][0] > info[0][0]      # geom 순서로 가면 아래쪽으로 가는가
            base = e["meters"] / (e["meters"] / e["seconds"] * f) if e["seconds"] else 0
            for frm, to, g, down in ((e["from"], e["to"], geom, fwd_down),
                                     (e["to"], e["from"], list(reversed(geom)), not fwd_down)):
                per_floor = FLOOR_DOWN_SECONDS if down else FLOOR_UP_SECONDS
                new_edges.append({**e, "from": frm, "to": to, "oneway": True, "geom": g,
                                  "slope": sl["name"],
                                  "seconds": round(base + floors * drop * per_floor, 1)})
            hit += 1
        edges[:] = new_edges
        if hit == 0:
            print(f"  ! 경사로 '{sl['name']}' 에 해당하는 길을 못 찾음 — line 좌표를 확인")
        slope_count += hit

# 5) 접근로까지 붙인 뒤 연결성을 다시 잰다
adj = defaultdict(list)
for e in edges:
    adj[e["from"]].append(e["to"])
    adj[e["to"]].append(e["from"])
seen, comps = set(), []
for s in graph_nodes:
    if s in seen:
        continue
    q, comp = deque([s]), []
    seen.add(s)
    while q:
        u = q.popleft(); comp.append(u)
        for v in adj[u]:
            if v not in seen:
                seen.add(v); q.append(v)
    comps.append(comp)
comps.sort(key=len, reverse=True)
main = set(comps[0]) if comps else set()
for s in snaps:
    s["in_main_component"] = s["node"] in main

(ROOT / "data" / "outdoor-graph.json").write_text(json.dumps({
    "_generated": "tools/extract_paths.py",
    "_source": "OpenStreetMap (ODbL) — © OpenStreetMap contributors",
    "_note": "service 도로 포함(캠퍼스 내 통로는 보행 가능). primary/secondary 제외. "
             "kind=approach 는 건물 외곽에서 길까지 자동 생성한 구간이며 실제 출입구가 아니다.",
    "nodes": graph_nodes, "edges": edges, "building_snap": snaps,
}, ensure_ascii=False, indent=2), encoding="utf-8")

kinds = defaultdict(int)
for e in edges:
    kinds[e["kind"]] += 1
total_m = sum(e["meters"] for e in edges)
print(f"노드 {len(graph_nodes)}개 · 엣지 {len(edges)}개 · 총연장 {total_m/1000:.2f}km")
print(f"엣지를 쪼갠 횟수 {split_count}회 · 관통 {shortcut_count}개 · 건물 직통 {conn_count}개 · 경사로 엣지 {slope_count}개")
print(f"찍은 문 {surveyed_count}개 / 건물 {len(surveyed)}곳 (나머지는 추정)")
if BLOCKED_WAYS:
    missing = BLOCKED_WAYS - blocked_hit
    print(f"막은 OSM 길 {len(blocked_hit)}개" + (f" · 원본에 없는 id {sorted(missing)}" if missing else ""))
print("종류별:", dict(sorted(kinds.items(), key=lambda kv: -kv[1])))
print(f"연결 덩어리 {len(comps)}개, 최대 덩어리에 {len(main)}/{len(graph_nodes)}개 "
      f"({len(main)/max(len(graph_nodes),1)*100:.0f}%)")

print("\n건물별 출입 지점 (자동 생성)")
off = 0
for s in sorted(snaps, key=lambda s: -s["doors"]):
    flag = "" if s["in_main_component"] else "  ⚠ 끊긴 덩어리"
    if not s["in_main_component"]: off += 1
    print(f"  {s['code']:>2} {s['name']:<14} 문 {s['doors']}곳, 가장 가까운 길 {s['approach_meters']:5.1f}m{flag}")
print(f"\n본 덩어리에서 떨어진 건물 {off}개")
