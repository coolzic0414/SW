import { test } from "node:test";
import assert from "node:assert/strict";
import { findRoute, type Graph, type GraphEdge } from "./graph.ts";

const e = (from: string, to: string, p: Partial<GraphEdge> = {}): GraphEdge => ({
  from, to, kind: "footway", meters: 100, seconds: 100, indoor: false, source: "osm", ...p,
});

//  A ──100s── B ──100s── C        (바깥 길)
//  A ─────────300s───────── C     (돌아가는 길)
//  A ══60s══ X ══60s══ C          (건물 관통, 실내, 계단 있음)
const g: Graph = {
  nodes: { A: { lat: 0, lon: 0 }, B: { lat: 0, lon: 1 }, C: { lat: 0, lon: 2 }, X: { lat: 1, lon: 1 } },
  edges: [
    e("A", "B"), e("B", "C"),
    e("A", "C", { seconds: 300, meters: 300 }),
    e("A", "X", { kind: "through_building", seconds: 60, meters: 60, indoor: true, accessible: false }),
    e("X", "C", { kind: "through_building", seconds: 60, meters: 60, indoor: true, accessible: false }),
  ],
};

test("가장 빠른 길을 고른다 — 건물 관통이 바깥보다 빠르면 관통한다", () => {
  const r = findRoute(g, "A", "C")!;
  assert.equal(r.seconds, 120);
  assert.deepEqual(r.nodes, ["A", "X", "C"]);
});

test("지름길을 끄면 바깥 길로 돈다 — 카카오맵 비교용 대조군", () => {
  const r = findRoute(g, "A", "C", { noShortcut: true })!;
  assert.equal(r.seconds, 200);
  assert.deepEqual(r.nodes, ["A", "B", "C"]);
  // 관통 대비 80초 손해 = 우리 서비스가 만드는 차이
  assert.equal(r.seconds - findRoute(g, "A", "C")!.seconds, 80);
});

test("비 안 맞는 길은 야외에 벌점을 줘서 실내를 고른다", () => {
  const r = findRoute(g, "A", "C", { preferIndoor: true })!;
  assert.equal(r.outdoorSeconds, 0);
  assert.deepEqual(r.nodes, ["A", "X", "C"]);
});

test("계단 없는 길은 계단·미확인 관통을 피하고 OSM 일반 도로로 간다", () => {
  // 관통(계단 있음)은 빼고, OSM 일반 도로(계단이 아님)로 돈다
  const r = findRoute(g, "A", "C", { stepFree: true })!;
  assert.deepEqual(r.nodes, ["A", "B", "C"]);

  // 사람이 손으로 넣은 길은 계단 없음이 확인돼야 쓴다
  const manual: Graph = { ...g, edges: g.edges.map((x) =>
    x.kind === "footway" ? { ...x, source: "knowledge" } : x) };
  assert.equal(findRoute(manual, "A", "C", { stepFree: true }), null);
  const confirmed: Graph = { ...manual, edges: manual.edges.map((x) =>
    x.from === "A" && x.to === "B" || x.from === "B" && x.to === "C" ? { ...x, accessible: true } : x) };
  assert.deepEqual(findRoute(confirmed, "A", "C", { stepFree: true })!.nodes, ["A", "B", "C"]);
});

test("계단 없는 길에서 OSM 계단(highway=steps)은 쓰지 않는다", () => {
  const steps: Graph = { ...g, edges: g.edges.map((x) =>
    x.from === "A" && x.to === "B" ? { ...x, kind: "steps" } : x) };
  assert.deepEqual(findRoute(steps, "A", "C", { stepFree: true })!.nodes, ["A", "C"]);
});

test("야외 노출 시간을 따로 센다", () => {
  const r = findRoute(g, "A", "C", { noShortcut: true })!;
  assert.equal(r.outdoorSeconds, 200);
});

test("짐작한 문을 쓴 경로만 표시된다", () => {
  // OSM 도로는 확인된 것으로 본다. 표시 대상은 자동 생성한 접근로(auto)뿐이다.
  const auto: Graph = { ...g, edges: g.edges.map((x) => ({ ...x, source: "auto" })) };
  assert.equal(findRoute(auto, "A", "C")!.hasUnverified, true);
  assert.equal(findRoute(g, "A", "C")!.hasUnverified, false);
});

test("닿을 수 없으면 null", () => {
  const iso: Graph = { nodes: { ...g.nodes, Z: { lat: 9, lon: 9 } }, edges: g.edges };
  assert.equal(findRoute(iso, "A", "Z"), null);
  assert.equal(findRoute(g, "A", "없는노드"), null);
});

test("건물을 통과로로 쓰지 않는다 — 관통로가 등록된 경우에만 지나간다", () => {
  // A ─ 문1 ─[건물 b:X]─ 문2 ─ C   (건물 안을 가로지르면 짧다)
  // A ───────── 바깥 길 ────────── C  (멀다)
  const g: Graph = {
    nodes: { A: { lat: 0, lon: 0 }, D1: { lat: 0, lon: 1 }, "b:X": { lat: 0, lon: 2 },
             D2: { lat: 0, lon: 3 }, C: { lat: 0, lon: 4 } },
    edges: [
      e("A", "D1", { seconds: 10, meters: 10 }),
      e("D1", "b:X", { kind: "indoor", indoor: true, seconds: 10, meters: 10 }),
      e("b:X", "D2", { kind: "indoor", indoor: true, seconds: 10, meters: 10 }),
      e("D2", "C", { seconds: 10, meters: 10 }),
      e("A", "C", { seconds: 300, meters: 300 }),
    ],
  };

  // 건물을 가로지르면 40초지만, 통과 가능한지 모르므로 바깥 길로 돌아야 한다
  const r = findRoute(g, "A", "C")!;
  assert.equal(r.seconds, 300, "건물 허브를 지나치면 안 된다");
  assert.deepEqual(r.nodes, ["A", "C"]);

  // 건물이 목적지일 때는 당연히 들어간다
  const into = findRoute(g, "A", "b:X")!;
  assert.equal(into.seconds, 20);

  // 관통로가 명시되면 그때는 가로지른다
  const withShortcut: Graph = {
    ...g,
    edges: [...g.edges, e("D1", "D2", { kind: "through_building", indoor: true, seconds: 15, meters: 15 })],
  };
  const sc = findRoute(withShortcut, "A", "C")!;
  assert.equal(sc.seconds, 35);
  assert.ok(sc.edges.some((x) => x.kind === "through_building"));
});

test("단방향 구간은 한쪽으로만 간다 — 올라가는 에스컬레이터", () => {
  // 아래(B) ↔ 위(T): 계단은 양방향 느리게, 에스컬레이터는 올라갈 때만 빠르게
  const g: Graph = {
    nodes: { B: { lat: 0, lon: 0 }, T: { lat: 1, lon: 0 } },
    edges: [
      e("B", "T", { kind: "steps", seconds: 190, meters: 86 }),
      e("B", "T", { kind: "escalator", seconds: 54, meters: 86, oneway: true, accessible: true }),
    ],
  };

  const up = findRoute(g, "B", "T")!;
  assert.equal(up.seconds, 54, "올라갈 때는 에스컬레이터");
  assert.equal(up.edges[0].kind, "escalator");

  const down = findRoute(g, "T", "B")!;
  assert.equal(down.seconds, 190, "내려올 때는 계단");
  assert.equal(down.edges[0].kind, "steps");
});

test("계단 없는 길에서는 에스컬레이터를 쓰고 계단은 피한다", () => {
  const g: Graph = {
    nodes: { B: { lat: 0, lon: 0 }, T: { lat: 1, lon: 0 } },
    edges: [
      e("B", "T", { kind: "steps", seconds: 190, meters: 86, accessible: false }),
      e("B", "T", { kind: "escalator", seconds: 54, meters: 86, oneway: true, accessible: true }),
    ],
  };
  assert.equal(findRoute(g, "B", "T", { stepFree: true })!.edges[0].kind, "escalator");
  assert.equal(findRoute(g, "T", "B", { stepFree: true }), null, "내려오는 무계단 길은 없다");
});
