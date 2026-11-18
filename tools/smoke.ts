// 스크린샷에 실제로 찍힌 강의실 코드가 건물 좌표까지 연결되는지 확인한다.
import { readFileSync } from "node:fs";
import { buildRoomCodeIndex, parseRoomCode, describe } from "../src/lib/roomCode.ts";

const table = JSON.parse(readFileSync("data/room-codes.json", "utf-8"));
const geo = JSON.parse(readFileSync("data/buildings.json", "utf-8"));
const idx = buildRoomCodeIndex(table);
const coord = new Map<string, number[]>(geo.buildings.map((b: any) => [b.code, b.center]));

const fromTimetable = ["RC220","RC213","ML325","RC212","U602","9115","L507","3209","U524","U527"];

console.log("입력      해석                          좌표");
console.log("-".repeat(72));
for (const s of fromTimetable) {
  const r = parseRoomCode(s, idx);
  const c = r.ok ? coord.get(r.code) : undefined;
  console.log(
    s.padEnd(9),
    describe(r).padEnd(28),
    c ? `${c[0].toFixed(5)}, ${c[1].toFixed(5)}` : "좌표 없음"
  );
}
