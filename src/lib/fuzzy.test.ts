import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, suggestPlaces } from "./campus.ts";

const pick = (s: string) => { const r = parse(s); return r.ok ? r.building + (r.room ? " " + r.room : "") : null; };

test("오타·초성·한영 실수·글자 빠짐도 하나로 분명하면 찾는다", () => {
  assert.equal(pick("공헉관"), "공학관");
  assert.equal(pick("공학과"), "공학관");
  assert.equal(pick("ㄱㅎㄱ"), "공학관");
  assert.equal(pick("rhdgkrrhks"), "공학관");          // 한/영 전환 안 하고 친 '공학관'
  assert.equal(pick("유토피아"), "유니토피아관");
  assert.equal(pick("공헉관305"), "공학관 305");        // 호실까지
  assert.equal(pick("브맄스"), "BRIX관");
});

test("학생들 줄임말", () => {
  assert.equal(pick("중도"), "향설도서관");
  assert.equal(pick("인문대"), "인문과학관");
  assert.equal(pick("향설1"), "향설생활관1");
  assert.equal(pick("향설3"), "향설생활관3");
});

test("여러 곳에 해당하는 말은 고르지 않고 후보를 다 보여준다", () => {
  for (const s of ["기숙사", "과학관", "생활관", "미디어"]) assert.equal(parse(s).ok, false, s);
  assert.equal(suggestPlaces("기숙사", 8).length, 7);
  assert.equal(suggestPlaces("과학관", 8).length >= 4, true);
});

test("관계없는 말에는 아무것도 추천하지 않는다", () => {
  for (const s of ["가나다라", "zzz"]) { assert.equal(parse(s).ok, false); assert.equal(suggestPlaces(s).length, 0); }
});

test("정확한 입력은 그대로 (보정 표시 없음)", () => {
  const r = parse("공학관");
  assert.ok(r.ok && !r.typed);
  const u = parse("U524");
  assert.ok(u.ok && u.code === "U" && u.room === "524");
});
