/** 데이터 파일들을 한데 묶어 화면이 쓰기 좋은 형태로 내놓는다. */
import roomCodes from "../../data/room-codes.json";
import buildingsJson from "../../data/buildings.json";
import graphJson from "../../data/outdoor-graph.json";
import { buildRoomCodeIndex, parseRoomCode, describe, type ParseResult } from "./roomCode.ts";
import { findRoute, isBuildingHub, type Graph, type GraphEdge, type RouteOptions, type Route } from "./graph.ts";

export interface Building {
  code: string;
  name: string;
  aliases: string[];
  center: [number, number];
  polygon: [number, number][];
  source: string;
}

export const buildings = buildingsJson.buildings as unknown as Building[];
export const graph = graphJson as unknown as Graph & {
  building_snap: { code: string; node: string; approach_meters: number }[];
};

// 강의실 코드가 없는 건물(@로 시작)도 이름으로 찾을 수 있게 파서에 같이 넘긴다.
const landmarks = buildings.filter((b) => b.code.startsWith("@"));
const idx = buildRoomCodeIndex(roomCodes as any, landmarks);
const snapByCode = new Map(graph.building_snap.map((s) => [s.code, s]));
const buildingByCode = new Map(buildings.map((b) => [b.code, b]));

export const parse = (s: string): ParseResult => parseRoomCode(s, idx);
export { describe };
export const getBuilding = (code: string) => buildingByCode.get(code);

/** 지도에 한 줄로 그릴 구간. 종류·출처에 따라 선 모양을 달리한다. */
export interface RouteSegment {
  kind: string;
  source: string;
  points: [number, number][];
}

export interface CampusRoute extends Route {
  /** 구간별 선 (색·점선 구분용) */
  segments: RouteSegment[];
  /** 지도 범위 맞추기용 전체 좌표 */
  path: [number, number][];
  /** 자동 생성한 접근로 길이. 실제 출입구가 아니라 건물 외곽에서 길까지 그은 선이다. */
  approachMeters: number;
  /** 건물 안에서 출발했으면 나가는 문 이름 (정문·북측문…). 길 위에서 출발했으면 없음 */
  exitDoor?: string | null;
}

/** 경로의 엣지들을 지도에 그릴 선으로 펼친다. 엣지 모양(geom)은 진행 방향에 맞춰 뒤집는다. */
function expand(g: Graph, r: Route): { segments: RouteSegment[]; path: [number, number][] } {
  const segments: RouteSegment[] = r.edges.map((e, i) => {
    const head = g.nodes[r.nodes[i]];
    const tail = g.nodes[r.nodes[i + 1]];
    const geom = (e as { geom?: [number, number][] }).geom;
    let points: [number, number][];
    if (geom?.length) {
      const first = geom[0];
      const last = geom[geom.length - 1];
      const forward =
        Math.hypot(first[0] - head.lat, first[1] - head.lon) <=
        Math.hypot(last[0] - head.lat, last[1] - head.lon);
      points = (forward ? geom : [...geom].reverse()).map((p) => [p[0], p[1]]);
    } else {
      points = [[head.lat, head.lon], [tail.lat, tail.lon]];
    }
    return { kind: e.kind, source: e.source, points };
  });
  return { segments, path: segments.flatMap((s) => s.points) };
}

/** 건물 허브(b:코드)와 실내 구간으로 이어진 문들. 출발할 때 '어느 문으로 나갈지' 후보다. */
const doorsByHub = new Map<string, string[]>();
for (const e of graph.edges) {
  if (e.kind !== "indoor") continue;
  for (const [hub, door] of [[e.from, e.to], [e.to, e.from]]) {
    if (!isBuildingHub(hub) || isBuildingHub(door)) continue;
    const list = doorsByHub.get(hub) ?? doorsByHub.set(hub, []).get(hub)!;
    if (!list.includes(door)) list.push(door);
  }
}

/** 문 노드 id 에서 사람이 읽을 이름. `ds:9:1-북측문` → 북측문 */
const doorName = (id: string) => id.match(/-([^-]+)$/)?.[1] ?? null;

/**
 * 건물 안에서 출발하는 경로.
 *
 * 건물 안 어디에 있는지는 모른다 — 실내에선 GPS 가 수십 m 틀리고, 건물을 골라 출발할 때도 마찬가지다.
 * 예전엔 건물 한가운데(허브)에서 출발해 '가운데 → 문' 시간을 더했다. 그러면 가운데서 가까운 문이
 * 유리해져서, 목적지 쪽 문이 따로 있는데도 정문으로 나가라고 했다 (공학관: 정문 15초, 북측문 40초).
 * 그래서 모든 문에서 동시에 출발해(0초짜리 가상 구간) 목적지까지 가장 빠른 문을 고른다.
 * 결과는 그 문에서 시작하므로 '어디로 나가는지' 가 첫 구간이 된다.
 */
function routeOutOf(g: Graph, hub: string, goal: string, opts: RouteOptions): (Route & { exitDoor: string | null }) | null {
  const doors = doorsByHub.get(hub) ?? [];
  if (!doors.length) {
    const r = findRoute(g, hub, goal, opts);
    return r ? { ...r, exitDoor: null } : null;
  }
  const S = "@start";
  const g2: Graph = {
    nodes: { ...g.nodes, [S]: g.nodes[hub] },
    edges: [
      ...g.edges,
      ...doors.map((d) => ({ from: S, to: d, kind: "virtual", meters: 0, seconds: 0, indoor: true,
                             source: "virtual", accessible: true, oneway: true }) as GraphEdge),
    ],
  };
  const r = findRoute(g2, S, goal, opts);
  if (!r) return null;
  return { ...r, nodes: r.nodes.slice(1), edges: r.edges.slice(1), exitDoor: doorName(r.nodes[1]) };
}

export function routeBetween(fromCode: string, toCode: string, opts: RouteOptions = {}): CampusRoute | null {
  const a = snapByCode.get(fromCode);
  const b = snapByCode.get(toCode);
  if (!a || !b || a.node === b.node) return null;

  const r = routeOutOf(graph, a.node, b.node, opts);
  if (!r) return null;
  return { ...r, ...expand(graph, r), approachMeters: Math.round(a.approach_meters + b.approach_meters) };
}

const meters = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));

function insideRing(p: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ay, ax] = ring[i], [by, bx] = ring[j];
    if ((ay > p[0]) !== (by > p[0]) && p[1] < ((bx - ax) * (p[0] - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** 점에서 건물 외곽선까지 거리(m). 안에 있으면 0. */
function distToRing(p: [number, number], ring: [number, number][]): number {
  if (insideRing(p, ring)) return 0;
  const K = 111_320 * Math.cos((p[0] * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][1] - p[1]) * K, ay = (ring[j][0] - p[0]) * 111_320;
    const bx = (ring[i][1] - p[1]) * K, by = (ring[i][0] - p[0]) * 111_320;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
  }
  return best;
}

/** 위치 오차가 이보다 커도 건물 밖 이만큼까지만 '건물 안' 으로 본다. 더 넓히면 건물 옆 길을 걷는 사람까지 건물 안으로 잡는다. */
export const INDOOR_SLACK_MAX = 12;

/**
 * 이 좌표가 들어 있는 건물. 강의실 안에서 길을 찾으면 그 건물 문으로 나가야 한다.
 * 실내에선 GPS 가 벽 밖으로 튄다. 그래서 위치 오차(accuracy)만큼은 — 최대 12m — 외곽선 밖이어도 건물 안으로 본다.
 * 여러 건물이 걸리면 가장 가까운 건물.
 */
export function buildingAt(at: [number, number], accuracy = 0): Building | null {
  const slack = Math.min(Math.max(accuracy, 0), INDOOR_SLACK_MAX);
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of buildings) {
    if (b.polygon.length < 3) continue;
    const d = distToRing(at, b.polygon);
    if (d <= slack && d < bestD) { best = b; bestD = d; }
  }
  return best;
}

/** 현재 위치에서 길로 붙을 수 있는 최대 거리. 이보다 멀면 캠퍼스 밖으로 본다. */
export const HERE_SNAP_LIMIT = 120;

export interface HereRoute extends CampusRoute {
  /** 건물 안에서 출발했으면 그 건물. 아니면 null (길 위에서 출발) */
  startBuilding: Building | null;
}

/**
 * 현재 위치에서 목적지 건물까지.
 *
 * 건물 안이면 그 건물에서 출발한다(문으로 나가야 하니까).
 * 바깥이면 가장 가까운 바깥 길에 수선을 내려, 그 자리에서 길을 둘로 쪼개고 출발 노드를 끼워 넣는다.
 * 그래프 원본은 건드리지 않고 이번 탐색용 사본에만 넣는다.
 */
export function routeFromHere(at: [number, number], toCode: string, opts: RouteOptions = {}, accuracy = 0): HereRoute | null {
  const inside = buildingAt(at, accuracy);
  if (inside) {
    if (inside.code === toCode) return null;
    const r = routeBetween(inside.code, toCode, opts);
    return r ? { ...r, startBuilding: inside } : null;
  }
  const goal = snapByCode.get(toCode);
  if (!goal) return null;

  // 가장 가까운 바깥 길 조각 찾기. 한쪽으로만 가는 길(에스컬레이터·관통·경사로)은 반으로 못 쪼개서 뺀다.
  const K = 111_320 * Math.cos((at[0] * Math.PI) / 180);
  let best: { d: number; ei: number; k: number; t: number; p: [number, number] } | null = null;
  graph.edges.forEach((e, ei) => {
    if (e.oneway || e.kind === "indoor" || e.kind === "through_building" || e.kind === "approach") return;
    const geom = (e as { geom?: [number, number][] }).geom ??
      [[graph.nodes[e.from].lat, graph.nodes[e.from].lon], [graph.nodes[e.to].lat, graph.nodes[e.to].lon]];
    for (let k = 0; k < geom.length - 1; k++) {
      const ax = (geom[k][1] - at[1]) * K, ay = (geom[k][0] - at[0]) * 111_320;
      const bx = (geom[k + 1][1] - at[1]) * K, by = (geom[k + 1][0] - at[0]) * 111_320;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      if (!best || d < best.d) {
        best = { d, ei, k, t, p: [geom[k][0] + (geom[k + 1][0] - geom[k][0]) * t, geom[k][1] + (geom[k + 1][1] - geom[k][1]) * t] };
      }
    }
  });
  if (!best) return null;
  const { d, ei, k, p } = best as NonNullable<typeof best>;
  if (d > HERE_SNAP_LIMIT) return null;

  const e = graph.edges[ei];
  const geom = (e as { geom?: [number, number][] }).geom ??
    [[graph.nodes[e.from].lat, graph.nodes[e.from].lon], [graph.nodes[e.to].lat, graph.nodes[e.to].lon]];
  const toFrom = [p, ...geom.slice(0, k + 1).reverse()] as [number, number][];
  const toTo = [p, ...geom.slice(k + 1)] as [number, number][];
  const len = (pts: [number, number][]) => pts.slice(1).reduce((s, q, i) => s + meters(pts[i], q), 0);
  const whole = Math.max(len(geom as [number, number][]), 0.1);
  const part = (pts: [number, number][], to: string) => ({
    ...e, from: "@on", to, meters: Math.round(len(pts) * 10) / 10,
    seconds: Math.round(e.seconds * (len(pts) / whole) * 10) / 10, geom: pts,
  });
  const walk = Math.max(d, 1);

  const g: Graph = {
    nodes: { ...graph.nodes, "@here": { lat: at[0], lon: at[1] }, "@on": { lat: p[0], lon: p[1] } },
    edges: [
      ...graph.edges,
      { from: "@here", to: "@on", kind: "approach", meters: Math.round(walk * 10) / 10,
        seconds: Math.round((walk / 1.3) * 10) / 10, indoor: false, source: "gps", accessible: true,
        geom: [at, p] } as GraphEdge,
      part(toFrom, e.from) as GraphEdge,
      part(toTo, e.to) as GraphEdge,
    ],
  };
  const r = findRoute(g, "@here", goal.node, opts);
  if (!r) return null;
  return { ...r, ...expand(g, r), approachMeters: Math.round(walk + goal.approach_meters), startBuilding: null };
}

/** 좌표에서 가장 가까운 건물. limit(m) 을 넘으면 null — 지도 빈 곳을 눌렀을 때 아무거나 잡지 않게. */
export function nearestBuilding(at: [number, number], limitMeters = Infinity): Building | null {
  const K = Math.cos((at[0] * Math.PI) / 180) * 111_000;
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of buildings) {
    const d = Math.hypot((b.center[0] - at[0]) * 111_000, (b.center[1] - at[1]) * K);
    if (d < bestD) { bestD = d; best = b; }
  }
  return bestD <= limitMeters ? best : null;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}
