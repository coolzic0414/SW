import { test } from "node:test";
import assert from "node:assert/strict";
import { routeFromHere, buildingAt, getBuilding, HERE_SNAP_LIMIT } from "./campus.ts";

test("건물 안에서 찾으면 그 건물 문으로 나간다", () => {
  const u = getBuilding("U")!;
  assert.equal(buildingAt(u.center)?.code, "U");
  const r = routeFromHere(u.center, "9")!;
  assert.equal(r.startBuilding?.code, "U");
});

test("바깥 길 위에서는 가장 가까운 길에 붙어 출발한다", () => {
  // 공학관과 유니토피아 사이 바깥 (어느 건물에도 안 들어가는 점)
  const at: [number, number] = [36.76962, 126.93285];
  assert.equal(buildingAt(at), null);
  const r = routeFromHere(at, "ML")!;
  assert.ok(r, "경로가 나와야 한다");
  assert.equal(r.startBuilding, null);
  assert.deepEqual(r.path[0], at, "선은 내 자리에서 시작한다");
  assert.ok(r.meters > 50 && r.meters < 800);
});

test("캠퍼스에서 멀리 떨어져 있으면 경로를 만들지 않는다", () => {
  assert.equal(routeFromHere([36.80, 126.90], "U"), null);
  assert.ok(HERE_SNAP_LIMIT >= 50);
});

test("건물 안 어디에 있든 목적지에 가장 빠른 문으로 나간다", () => {
  // 공학관 안의 서로 먼 세 지점 (서쪽 끝·동쪽 끝·가운데)
  const pts: [number, number][] = [[36.76915, 126.93175], [36.76940, 126.93245], [36.7692366, 126.9321798]];
  for (const dest of ["U", "@교직원식당", "ML", "@글로벌빌리지"]) {
    const doors = pts.map((p) => routeFromHere(p, dest)!.exitDoor);
    assert.ok(doors[0], dest);
    assert.ok(doors.every((d) => d === doors[0]), `${dest}: ${doors.join(",")}`);
  }
  // 유니토피아는 북측문이 가장 빠르다 (예전엔 건물 가운데와 가까운 남동문으로 나가라고 했다)
  assert.equal(routeFromHere(pts[0], "U")!.exitDoor, "북측문");
});

test("실내에서 GPS 가 벽 밖으로 튀어도 오차 범위 안이면 건물 안으로 본다", () => {
  const out: [number, number] = [36.769146 - 0.00007, 126.931606];   // 공학관 남서 모서리에서 약 8m 밖
  assert.equal(buildingAt(out)?.code, undefined);          // 오차 정보 없으면 밖
  assert.equal(buildingAt(out, 3)?.code, undefined);       // 오차 3m 면 밖 (건물 옆 길을 걷는 사람)
  assert.equal(buildingAt(out, 25)?.code, "9");            // 실내처럼 오차가 크면 안
  assert.equal(routeFromHere(out, "U", {}, 25)!.startBuilding?.code, "9");
});
