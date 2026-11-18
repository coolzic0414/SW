// 실제 캠퍼스 그래프 위에서 강의실→강의실 경로가 나오는지 확인한다.
import { readFileSync } from "node:fs";
import { buildRoomCodeIndex, parseRoomCode, describe } from "../src/lib/roomCode.ts";
import { findRoute, type Graph } from "../src/lib/graph.ts";

const table = JSON.parse(readFileSync("data/room-codes.json", "utf-8"));
const g: Graph & { building_snap: any[] } = JSON.parse(readFileSync("data/outdoor-graph.json", "utf-8"));
const idx = buildRoomCodeIndex(table);
const snap = new Map(g.building_snap.map((s: any) => [s.code, s]));

function route(fromRoom: string, toRoom: string) {
  const a = parseRoomCode(fromRoom, idx), b = parseRoomCode(toRoom, idx);
  if (!a.ok || !b.ok) return console.log(`  ${fromRoom} → ${toRoom}: 파싱 실패`);
  const sa = snap.get(a.code), sb = snap.get(b.code);
  const r = findRoute(g, sa.node, sb.node);
  const head = `${describe(a)}  →  ${describe(b)}`;
  if (!r) return console.log(`${head}\n   경로 없음 (그래프가 끊김)\n`);
  const mm = Math.floor(r.seconds / 60), ss = r.seconds % 60;
  console.log(head);
  console.log(`   도보 ${mm}분 ${ss}초 · ${r.meters}m · 구간 ${r.edges.length}개` +
              `${r.hasUnverified ? " · 미확인 구간 포함" : ""}`);
  console.log(`   자동 생성 접근로 ${sa.approach_meters}m + ${sb.approach_meters}m 포함\n`);
}

console.log("=== 1학년 교양 강의실 사이 이동 ===\n");
route("U524", "9115");     // 유니토피아관 → 공학관
route("9115", "3209");     // 공학관 → 자연과학관
route("U527", "ML325");    // 유니토피아관 → 미디어랩스관 (캠퍼스 남북 종단)
route("RC220", "L507");    // 향설생활관1 → 중앙도서관
route("ML325", "인문관101"); // 미디어랩스관 → 인문과학관 (최장거리)
