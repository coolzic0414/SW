import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRoomCodeIndex, parseRoomCode, describe as describeRoom } from "./roomCode.ts";

const table = JSON.parse(readFileSync(new URL("../../data/room-codes.json", import.meta.url), "utf-8"));
const idx = buildRoomCodeIndex(table);
const p = (s: string) => parseRoomCode(s, idx);

test("실제 시간표에 찍힌 값들을 해석한다", () => {
  // 2026 1학년 교양 수업시간표에서 그대로 가져온 값
  const cases: [string, string, number][] = [
    ["U524", "유니토피아관", 5],
    ["U527", "유니토피아관", 5],
    ["U602", "유니토피아관", 6],
    ["L507", "향설도서관", 5],
    ["ML325", "SCH미디어랩스관", 3],
    ["RC212", "향설생활관1", 2],
    ["RC213", "향설생활관1", 2],
    ["RC220", "향설생활관1", 2],
    ["9115", "공학관", 1],
    ["3209", "자연과학관", 2],
  ];
  for (const [input, building, floor] of cases) {
    const r = p(input);
    assert.equal(r.ok, true, `${input} 파싱 실패`);
    if (!r.ok) return;
    assert.equal(r.building, building, input);
    assert.equal(r.floor, floor, input);
  }
});

test("두 글자 코드를 한 글자 코드보다 먼저 매칭한다", () => {
  // ML325 를 M(멀티미디어관) + L325 로 읽으면 틀린다
  const ml = p("ML325");
  assert.equal(ml.ok && ml.building, "SCH미디어랩스관");
  const m = p("M325");
  assert.equal(m.ok && m.building, "멀티미디어관");

  const rc = p("RC220");
  assert.equal(rc.ok && rc.building, "향설생활관1");
  const r = p("R220");
  assert.equal(r.ok && r.building, "학군단");

  const bi = p("BI101");
  assert.equal(bi.ok && bi.building, "BRIX관");
  const b = p("B101");
  assert.equal(b.ok && b.building, "산학협력관");
});

test("공백·하이픈·소문자를 받아들인다", () => {
  for (const s of ["u524", "U 524", "u-524", " U524 "]) {
    const r = p(s);
    assert.equal(r.ok && r.building, "유니토피아관", s);
    assert.equal(r.ok && r.normalized, "U524", s);
  }
});

test("한글 건물명과 학생 은어를 받는다", () => {
  // 은어는 재학생 확인을 거친 것만 넣는다. 지어낸 말을 넣으면 안 쓰는 검색어가 된다.
  const cases: [string, string][] = [
    ["공학관305", "공학관"],        // 공학관은 줄여 부르지 않는다
    ["유니토피아 524", "유니토피아관"],
    ["향1 220", "향설생활관1"],
    ["중앙도서관507", "향설도서관"],
    ["미랩325", "SCH미디어랩스관"],
    ["자연대209", "자연과학관"],
    ["인문관101", "인문과학관"],
    ["아이디자인201", "I'Design관"],
  ];
  for (const [input, building] of cases) {
    const r = p(input);
    assert.equal(r.ok, true, `${input} 파싱 실패`);
    assert.equal(r.ok && r.building, building, input);
  }
});

test("강의실이 아닌 코드는 거절한다", () => {
  const r = p("X004");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "not_classroom");
  assert.equal(!r.ok && r.reason === "not_classroom" && r.place, "수영장");
  assert.match(describeRoom(r), /강의실이 아닙니다/);
});

test("건물을 모르는 숫자는 후보를 돌려준다", () => {
  const r = p("305");
  assert.equal(!r.ok && r.reason, "ambiguous");
  // 후보 수는 코드표 길이를 따라간다. 건물이 추가돼도 테스트가 깨지지 않게.
  assert.equal(!r.ok && r.reason === "ambiguous" && r.candidates.length, table.buildings.length);
});

test("알 수 없는 입력은 실패로 끝난다", () => {
  // 건물 이름만 넣는 건 이제 유효하다(아래 전용 테스트). 여기선 정말 모르는 것만 본다.
  for (const s of ["", "ㅁㄴㅇㄹ", "Z999", "없는건물관"]) {
    assert.equal(p(s).ok, false, s);
  }
});

test("확인 카드 문구", () => {
  assert.equal(describeRoom(p("9115")), "공학관 1층 9115");
  assert.equal(describeRoom(p("U524")), "유니토피아관 5층 U524");
});

test("건물 이름이나 코드만 넣어도 목적지가 된다", () => {
  for (const [input, building] of [
    ["공학관", "공학관"],
    ["유니토피아", "유니토피아관"],
    ["중앙도서관", "향설도서관"],
    ["미랩", "SCH미디어랩스관"],
    ["ML", "SCH미디어랩스관"],
    ["U", "유니토피아관"],
  ] as [string, string][]) {
    const r = p(input);
    assert.equal(r.ok, true, `${input} 실패`);
    if (!r.ok) continue;
    assert.equal(r.building, building, input);
    assert.equal(r.room, "", "호실은 비어 있어야 한다");
    assert.equal(r.floor, null, "층은 알 수 없다");
    assert.equal(describeRoom(r), building, "안내 문구는 건물명만");
  }
});

test("건물만 지정해도 호실 지정과 섞이지 않는다", () => {
  const onlyBuilding = p("공학관");
  const withRoom = p("9115");
  assert.equal(onlyBuilding.ok && onlyBuilding.code, "9");
  assert.equal(withRoom.ok && withRoom.code, "9");
  assert.equal(withRoom.ok && withRoom.room, "115");
});

test("강의실 코드가 없는 건물도 이름으로 찾는다", () => {
  const lm = [
    { code: "@교직원식당", name: "교직원식당", aliases: ["교식"] },
    { code: "@향설생활관2", name: "향설생활관2", aliases: ["향2"] },
  ];
  const i = buildRoomCodeIndex(table, lm);
  for (const q of ["교직원식당", "교식", "향2", "@교직원식당"]) {
    const r = parseRoomCode(q, i);
    assert.equal(r.ok, true, `${q} 가 안 잡힘`);
    if (r.ok) assert.equal(r.code.startsWith("@"), true);
  }
  // 강의실 코드가 없으니 숫자를 붙이면 안 잡혀야 한다
  assert.equal(parseRoomCode("교직원식당301", i).ok, false);
  // 향1(=향설생활관1)은 강의동이라 그대로 강의동으로 잡힌다
  const r = parseRoomCode("향1 220", i);
  assert.equal(r.ok && r.code, "RC");
});

test("이름 일부만 쳐도 한 건물에만 맞으면 찾는다", () => {
  for (const [s, code] of [["BRIX", "BI"], ["brix", "BI"], ["미디어랩스", "ML"], ["미디어랩스관", "ML"]] as const) {
    const r = p(s);
    assert.ok(r.ok, s);
    assert.equal(r.ok && r.code, code, s);
  }
  // 여러 건물에 걸리는 말은 고르지 않는다 (자연·인문·의료과학관)
  assert.equal(p("과학관").ok, false);
});
