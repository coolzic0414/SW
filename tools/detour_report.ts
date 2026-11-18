/**
 * 경로 품질 지표 — 모든 건물 쌍의 '직선 대비 실제 걷는 거리' 비율.
 *
 * 문 위치가 실제와 가까워지거나 지름길이 늘면 이 값이 내려간다.
 * 상위 목록은 다음에 뭘 조사할지 알려준다. 다만 '길이 없는 게 맞다'고 확인된 구간도
 * 섞여 있으니 data/connections.json 의 _no_shortcut 을 먼저 보고 중복으로 묻지 말 것.
 *
 *   node tools/detour_report.ts
 */
import { readFileSync } from "node:fs";
import { findRoute, type Graph } from "../src/lib/graph.ts";

const g: Graph & { building_snap: { code: string; node: string }[] } =
  JSON.parse(readFileSync("data/outdoor-graph.json", "utf-8"));
const bl = JSON.parse(readFileSync("data/buildings.json", "utf-8")).buildings;
const at = new Map<string, [number, number]>(bl.map((b: any) => [b.code, b.center]));

const straight = (a: [number, number], b: [number, number]) =>
  Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180));

// 40m 안쪽은 접근로 길이가 비율을 지배해서 의미가 없다
const TOO_CLOSE = 40;

const rows: [number, string, string, number, number][] = [];
const snap = g.building_snap;
for (let i = 0; i < snap.length; i++) {
  for (let j = i + 1; j < snap.length; j++) {
    const r = findRoute(g, snap[i].node, snap[j].node);
    const d = straight(at.get(snap[i].code)!, at.get(snap[j].code)!);
    if (!r || d < TOO_CLOSE) continue;
    rows.push([r.meters / d, snap[i].code, snap[j].code, Math.round(r.meters), Math.round(d)]);
  }
}
rows.sort((a, b) => b[0] - a[0]);
const avg = rows.reduce((s, r) => s + r[0], 0) / rows.length;
console.log(`쌍 ${rows.length}개 · 평균 우회율 ${avg.toFixed(3)}배\n\n크게 도는 곳 (connections.json 의 _no_shortcut 을 먼저 확인)`);
for (const [ratio, a, b, m, d] of rows.slice(0, 8)) {
  console.log(`  ${a} → ${b}  ${ratio.toFixed(2)}배 (${m}m / 직선 ${d}m)`);
}
