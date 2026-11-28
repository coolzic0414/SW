/**
 * 경로 탐색. 카카오맵은 캠퍼스 보행로를 모르기 때문에 우리가 직접 계산한다.
 * 그래프가 작아서(노드 수백) 브라우저에서 다익스트라를 돌려도 충분하고,
 * 그래야 신호가 약한 건물 안에서도 동작한다.
 */

export interface GraphNode { lat: number; lon: number }

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  meters: number;
  seconds: number;
  /** 실내 구간인가. 비 오는 날 가중치에 쓴다. */
  indoor: boolean;
  /** osm | knowledge | measured — 화면에 출처를 표시한다 */
  source: string;
  /** 계단·문턱 없이 지날 수 있는가. 모르면 undefined (계단 없는 길에서 제외) */
  accessible?: boolean;
  /** from → to 한 방향으로만 통행 가능 (올라가는 에스컬레이터 등) */
  oneway?: boolean;
  name?: string | null;
}

export interface Graph { nodes: Record<string, GraphNode>; edges: GraphEdge[] }

export interface RouteOptions {
  /** 비 안 맞는 길: 야외 구간에 벌점을 준다 */
  preferIndoor?: boolean;
  /** 계단 없는 길: accessible 이 확인된 구간만 쓴다 */
  stepFree?: boolean;
  /** 건물 관통 지름길을 쓰지 않는다 (카카오맵과 비교할 때의 대조군) */
  noShortcut?: boolean;
  /**
   * 편한 길: 계단은 실제보다 몇 배 오래 걸리는 것처럼 쳐서 웬만하면 피하고, 에스컬레이터는 반긴다.
   * 막지는 않는다 — 계단밖에 없는 곳(산길 등)에서도 길은 나와야 한다.
   */
  comfort?: boolean;
}

/** 편한 길에서 계단 1초를 몇 초로 칠지. 3이면 계단 20초가 1분짜리로 보여 돌아가는 평지 길을 고른다. */
const COMFORT_STEPS = 3;
/** 편한 길에서 에스컬레이터를 얼마나 반길지 (1보다 작을수록 먼저 고른다) */
const COMFORT_ESCALATOR = 0.6;

export interface Route {
  nodes: string[];
  edges: GraphEdge[];
  seconds: number;
  meters: number;
  /** 야외에 노출되는 시간. 비 오는 날 판단 근거 */
  outdoorSeconds: number;
  /**
   * 사람이 확인하지 않고 기계가 짐작한 구간이 섞였는가.
   * OSM 도로(source: "osm")는 확인된 것으로 본다 — 따지는 건 '문이 거기 맞나' 뿐이다.
   * source: "auto" 는 문 위치를 길과의 최단 투영으로 만들어낸 접근로다.
   */
  hasUnverified: boolean;
}

const OUTDOOR_RAIN_PENALTY = 3;

/**
 * 계단 없이 지날 수 있는 구간인가.
 *
 * - 계단(steps)이거나 계단 있다고 확인된 구간(accessible:false)은 뺀다.
 * - OSM 일반 도로는 쓴다. OSM 은 계단을 highway=steps 로 따로 구분하므로
 *   service·footway 같은 길은 계단이 아니다. (이걸 '미확인' 으로 빼면 캠퍼스 어디서도 경로가 안 나온다)
 * - 건물 출입로·건물 안은 쓴다. 따로 계단이라고 확인된 게 아니면 막지 않는다.
 * - 손으로 넣은 길·건물 관통처럼 사람이 적은 구간은 계단 없음이 확인됐을 때만 쓴다.
 */
function stepFreeOk(e: GraphEdge): boolean {
  if (e.kind === "steps" || e.accessible === false) return false;
  if (e.accessible === true) return true;
  return e.source === "osm" || e.kind === "approach" || e.kind === "indoor";
}

function usable(e: GraphEdge, o: RouteOptions): boolean {
  if (o.stepFree && !stepFreeOk(e)) return false;
  if (o.noShortcut && e.kind === "through_building") return false;
  return true;
}

function cost(e: GraphEdge, o: RouteOptions): number {
  let c = o.preferIndoor && !e.indoor ? e.seconds * OUTDOOR_RAIN_PENALTY : e.seconds;
  if (o.comfort) {
    if (e.kind === "steps" || e.accessible === false) c *= COMFORT_STEPS;
    else if (e.kind === "escalator") c *= COMFORT_ESCALATOR;
  }
  return c;
}

/** 건물을 대표하는 노드. extract_paths.py 가 `b:<건물코드>` 로 만든다. */
export const isBuildingHub = (id: string) => id.startsWith("b:");

/** 작은 그래프라 이진 힙 없이 선형 탐색으로 충분하다. 노드 수천까지는 체감 차이가 없다. */
export function findRoute(g: Graph, start: string, goal: string, o: RouteOptions = {}): Route | null {
  if (!(start in g.nodes) || !(goal in g.nodes)) return null;

  const adj = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    if (!usable(e, o)) continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);
    // 올라가는 에스컬레이터처럼 한 방향으로만 갈 수 있는 구간이 있다.
    if (e.oneway) continue;
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push({ ...e, from: e.to, to: e.from });
  }

  const dist = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, { node: string; edge: GraphEdge }>();
  const done = new Set<string>();

  for (;;) {
    let u: string | null = null;
    let best = Infinity;
    for (const [n, d] of dist) if (!done.has(n) && d < best) { best = d; u = n; }
    if (u === null) return null;
    if (u === goal) break;
    done.add(u);

    // 건물 허브는 출발·도착 지점일 뿐 통과로가 아니다.
    // 막지 않으면 "한쪽 문으로 들어가 반대편으로 나오기"가 공짜가 되어,
    // 통과 가능한지 알지도 못하는 건물을 가로지르는 경로가 나온다.
    // 실제 관통로는 through_building 엣지로 따로 넣는다.
    if (u !== start && isBuildingHub(u)) continue;

    for (const e of adj.get(u) ?? []) {
      const nd = best + cost(e, o);
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: u, edge: e });
      }
    }
  }

  const nodes = [goal];
  const edges: GraphEdge[] = [];
  for (let cur = goal; cur !== start; ) {
    const p = prev.get(cur);
    if (!p) return null;
    edges.unshift(p.edge);
    nodes.unshift(p.node);
    cur = p.node;
  }

  return {
    nodes,
    edges,
    seconds: Math.round(edges.reduce((s, e) => s + e.seconds, 0)),
    meters: Math.round(edges.reduce((s, e) => s + e.meters, 0)),
    outdoorSeconds: Math.round(edges.filter((e) => !e.indoor).reduce((s, e) => s + e.seconds, 0)),
    hasUnverified: edges.some((e) => e.source === "auto"),
  };
}
