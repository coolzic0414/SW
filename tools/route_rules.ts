/**
 * 재학생이 알려준 동선 규칙을 한 번에 검사한다.
 *
 * 경로 하나 고치면 다른 데가 깨진다. 지적받은 걸 하나씩 눈으로 확인하는 대신,
 * 들은 규칙을 전부 여기 적어두고 그래프를 다시 만들 때마다 돌린다.
 *
 *   node tools/route_rules.ts
 */
import { readFileSync } from "node:fs";
import { findRoute, type Graph, type RouteOptions } from "../src/lib/graph.ts";

const g: Graph & { building_snap: { code: string; node: string }[] } =
  JSON.parse(readFileSync("data/outdoor-graph.json", "utf-8"));
const names = new Map<string, string>(
  JSON.parse(readFileSync("data/buildings.json", "utf-8")).buildings.map((b: any) => [b.code, b.name]));
const snap = new Map(g.building_snap.map((s) => [s.code, s.node]));

type R = NonNullable<ReturnType<typeof findRoute>>;
const uses = (r: R, part: string) => r.edges.some((e: any) => (e.name ?? "").includes(part));
// 보육센터 남·동쪽 순환로 = '보육센터 뒤로 돌아가는' 길
const behindIncubator = (r: R) => r.edges.some((e: any) =>
  (e.geom ?? []).some((p: number[]) => p[0] < 36.7698 && p[1] > 126.93295 && p[1] < 126.9338));

// I'Design관 뒤 주차장 통로(OSM way 471804242 의 가운데 점)를 지나는가
const behindIDesign = (r: R) => r.nodes.includes("8953774249");
const enterDoor = (r: R) => r.edges.filter((e: any) => e.kind === "approach").pop()?.name;

const rules: [string, string, string, (r: R) => boolean, RouteOptions?][] = [
  ["의료과학관 → 학생회관은 큰길을 따라가다 정문으로 들어간다 (I'Design관 뒤 주차장으로 안 간다)", "1", "@학생회관",
   (r) => !behindIDesign(r) && enterDoor(r) === "정문"],
  ["교직원식당 → 학생회관도 큰길을 따라 정문으로", "@교직원식당", "@학생회관", (r) => !behindIDesign(r) && enterDoor(r) === "정문"],
  ["미랩 → 학생회관도 큰길을 따라 정문으로", "ML", "@학생회관", (r) => !behindIDesign(r) && enterDoor(r) === "정문"],
  ["인문과학관 → 학군단은 대운동장을 가로지른다 (남쪽 계단 → 체육관 옆 통로)", "6", "R",
   (r) => uses(r, "대운동장 가로지르기") && uses(r, "대운동장 남쪽 계단") && uses(r, "체육관 옆 통로")],
  ["학군단 → 대학본부도 대운동장을 가로지른다", "R", "@대학본부", (r) => uses(r, "대운동장 가로지르기")],
  ["향2 → 미랩은 유니토피아를 관통한다", "@향설생활관2", "ML", (r) => uses(r, "유니토피아관 관통")],
  ["향2 → 미랩은 공학관 앞 산길 계단으로 내려간다", "@향설생활관2", "ML", (r) => uses(r, "산길 계단")],
  ["향2 → 공학관은 향설생활관1을 관통한다", "@향설생활관2", "9", (r) => uses(r, "향설생활관1 관통")],
  ["공학관 → 미랩은 산길 계단으로 내려간다", "9", "ML", (r) => uses(r, "산길 계단")],
  ["미랩 → BRIX는 산길 계단으로 올라간다 (교직원식당 쪽으로 돌지 않는다)", "ML", "BI",
   (r) => uses(r, "산길 계단") && !uses(r, "걷고싶은 길")],
  ["의료과학관 → 미랩은 북동쪽 정문으로 나간다 (주차장 측문으로 돌지 않는다)", "1", "ML",
    (r) => (r.edges[1] as any)?.name === "정문"],
  ["공학관 → 교직원식당은 걷고싶은 길로 간다", "9", "@교직원식당", (r) => uses(r, "걷고싶은 길")],
  ["BRIX → 교직원식당은 걷고싶은 길로 간다", "BI", "@교직원식당", (r) => uses(r, "걷고싶은 길")],
  ["BRIX → 교직원식당은 보육센터 뒤로 돌지 않는다", "BI", "@교직원식당", (r) => !behindIncubator(r)],
  ["지역혁신관 → 교직원식당은 보육센터 뒤로 돌지 않는다", "C", "@교직원식당", (r) => !behindIncubator(r)],
  ["지역혁신관 → 학성사3은 걷고싶은 길로 간다", "C", "@학성사3", (r) => uses(r, "걷고싶은 길")],
  ["에스컬레이터는 올라가는 쪽(학생회관→공학관)에만 쓴다", "9", "@학생회관", (r) => !uses(r, "에스컬레이터")],
  ["계단 없는 길에서는 산길 계단을 안 쓴다", "9", "ML", (r) => !uses(r, "산길 계단"), { stepFree: true }],
  ["계단 없는 길에서는 향설생활관2 관통(계단)을 안 쓴다", "@글로벌빌리지", "RC", (r) => !uses(r, "향설생활관2 관통"), { stepFree: true }],
];

// 그려지는 선이 중간에 끊기면 '산을 뚫고 가는' 것처럼 보인다
function gaps(r: R) {
  let prev: number[] | null = null, worst = 0;
  r.edges.forEach((e: any, i) => {
    const head = (g.nodes as any)[r.nodes[i]];
    const geom = e.geom ?? [[head.lat, head.lon]];
    const f = geom[0], l = geom[geom.length - 1];
    const fwd = Math.hypot(f[0] - head.lat, f[1] - head.lon) <= Math.hypot(l[0] - head.lat, l[1] - head.lon);
    const pts = fwd ? geom : [...geom].reverse();
    if (prev) worst = Math.max(worst, Math.hypot((pts[0][0] - prev[0]) * 111320, (pts[0][1] - prev[1]) * 89270));
    prev = pts[pts.length - 1];
  });
  return worst;
}

let fail = 0;
for (const [title, a, b, ok, opts] of rules) {
  const r = findRoute(g, snap.get(a)!, snap.get(b)!, opts ?? {});
  const pass = !!r && ok(r);
  if (!pass) fail++;
  const via = r ? [...new Set(r.edges.map((e: any) => (e.name ?? "").replace(/ \((내려감|올라감)\)| (연결|갈림)$/g, "")).filter(Boolean))].join(" · ") : "경로 없음";
  console.log(`${pass ? "✓" : "✗"} ${title}\n    ${names.get(a)} → ${names.get(b)} ${r?.meters}m ${r?.seconds}초  [${via}]`);
}

// 모든 건물 쌍에서 선이 끊기는 경로가 없는지
let worstGap = 0, worstPair = "";
for (const s of g.building_snap) for (const t of g.building_snap) {
  if (s === t) continue;
  const r = findRoute(g, s.node, t.node);
  if (!r) continue;
  const w = gaps(r);
  if (w > worstGap) { worstGap = w; worstPair = `${names.get(s.code)} → ${names.get(t.code)}`; }
}
// 문에서 길로 나가는 선(접근로)이 건물 안을 지나가면, 문을 나가 벽을 뚫고 반대편 길로 가는 꼴이다
const blds = JSON.parse(readFileSync("data/buildings.json", "utf-8")).buildings
  .filter((b: any) => (b.polygon?.length ?? 0) >= 3);
const inRing = (p: number[], ring: number[][]) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    if ((ring[i][0] > p[0]) !== (ring[j][0] > p[0]) &&
        p[1] < ((ring[j][1] - ring[i][1]) * (p[0] - ring[i][0])) / (ring[j][0] - ring[i][0]) + ring[i][1]) c = !c;
  return c;
};
const crossing: string[] = [];
for (const e of g.edges as any[]) {
  if (e.kind !== "approach" || !e.geom) continue;
  const [a, b] = [e.geom[0], e.geom[e.geom.length - 1]];
  const L = Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 89270);
  for (let k = 1; k < 20; k++) {
    const t = k / 20;
    if (t * L < 1.5 || (1 - t) * L < 1.5) continue;
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const hit = blds.find((bb: any) => inRing(q, bb.polygon));
    if (hit) { crossing.push(`${e.from} (${hit.name})`); break; }
  }
}
const crossOk = crossing.length === 0;
if (!crossOk) fail++;
console.log(`${crossOk ? "✓" : "✗"} 문에서 길로 나가는 선이 건물을 가로지르지 않는다${crossOk ? "" : " — " + crossing.join(", ")}`);

const gapOk = worstGap < 2;
if (!gapOk) fail++;
console.log(`${gapOk ? "✓" : "✗"} 모든 경로에서 그려지는 선이 끊기지 않는다 (최대 ${worstGap.toFixed(1)}m · ${worstPair})`);

console.log(`\n${rules.length + 2 - fail}/${rules.length + 2} 통과`);
process.exit(fail ? 1 : 0);
