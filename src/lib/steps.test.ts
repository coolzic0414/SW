import { test } from "node:test";
import assert from "node:assert/strict";
import { bearing, turnDelta, buildSteps } from "./steps.ts";
import type { CampusRoute } from "./campus.ts";

test("방위각 — 북/동/남/서", () => {
  const o: [number, number] = [36.77, 126.93];
  assert.ok(Math.abs(bearing(o, [36.771, 126.93]) - 0) < 1, "북");
  assert.ok(Math.abs(bearing(o, [36.77, 126.931]) - 90) < 1, "동");
  assert.ok(Math.abs(bearing(o, [36.769, 126.93]) - 180) < 1, "남");
  assert.ok(Math.abs(bearing(o, [36.77, 126.929]) - 270) < 1, "서");
});

test("방향 변화량은 -180~180 으로 접힌다", () => {
  assert.equal(turnDelta(350, 10), 20);   // 북쪽을 넘어가도 20도
  assert.equal(turnDelta(10, 350), -20);
  assert.equal(turnDelta(0, 90), 90);
});

function route(segs: { kind: string; pts: [number, number][]; sec?: number; m?: number }[]): CampusRoute {
  return {
    nodes: [], meters: 0, seconds: 0, outdoorSeconds: 0, hasUnverified: false,
    approachMeters: 0, path: [],
    edges: segs.map((s) => ({
      from: "a", to: "b", kind: s.kind, meters: s.m ?? 50, seconds: s.sec ?? 40,
      indoor: false, source: "osm",
    })),
    segments: segs.map((s) => ({ kind: s.kind, source: "osm", points: s.pts })),
  } as unknown as CampusRoute;
}

test("출발과 도착이 항상 양 끝에 붙는다", () => {
  const s = buildSteps(route([{ kind: "footway", pts: [[36.77, 126.93], [36.771, 126.93]] }]), "공학관", "유니토피아관");
  assert.equal(s[0].kind, "start");
  assert.match(s[0].text, /공학관에서 출발/);
  assert.equal(s[s.length - 1].kind, "arrive");
  assert.match(s[s.length - 1].text, /유니토피아관 도착/);
});

test("같은 방향으로 이어지면 한 단계로 합친다", () => {
  const north: [number, number][] = [[36.770, 126.93], [36.771, 126.93]];
  const more: [number, number][] = [[36.771, 126.93], [36.772, 126.93]];
  const s = buildSteps(route([
    { kind: "footway", pts: north, sec: 30 },
    { kind: "footway", pts: more, sec: 20 },
  ]), "A", "B");
  const walking = s.filter((x) => x.kind === "straight");
  assert.equal(walking.length, 1, "직진이 두 번 나오면 안 된다");
  assert.equal(walking[0].seconds, 50, "시간은 합산된다");
});

test("오른쪽·왼쪽 꺾임을 구분한다", () => {
  const north: [number, number][] = [[36.770, 126.930], [36.772, 126.930]];
  const east: [number, number][] = [[36.772, 126.930], [36.772, 126.932]];
  const west: [number, number][] = [[36.772, 126.930], [36.772, 126.928]];

  const right = buildSteps(route([{ kind: "footway", pts: north }, { kind: "footway", pts: east }]), "A", "B");
  assert.ok(right.some((x) => x.kind === "right"), "동쪽으로 꺾으면 오른쪽");

  const left = buildSteps(route([{ kind: "footway", pts: north }, { kind: "footway", pts: west }]), "A", "B");
  assert.ok(left.some((x) => x.kind === "left"), "서쪽으로 꺾으면 왼쪽");
});

test("건물 관통과 접근로는 따로 표시된다", () => {
  const s = buildSteps(route([
    { kind: "approach", pts: [[36.770, 126.930], [36.7705, 126.930]] },
    { kind: "through_building", pts: [[36.7705, 126.930], [36.771, 126.930]] },
  ]), "A", "B");
  assert.ok(s.some((x) => x.kind === "approach"));
  assert.ok(s.some((x) => x.kind === "through" && /통과/.test(x.text)));
});

test("경사지 건물 관통은 들어가는 층과 나오는 층을 알려 준다", () => {
  const through = (name: string, floors: number) => {
    const r = route([{ kind: "through_building", pts: [[36.7705, 126.930], [36.771, 126.930]] }]);
    Object.assign(r.edges[0], { name, floors });
    return buildSteps(r, "A", "B").find((x) => x.kind === "through")!.text;
  };
  assert.equal(through("앙뜨레프레너관 관통 (내려감)", 2), "앙뜨레프레너관 3층으로 들어가 1층으로 나오기");
  assert.equal(through("앙뜨레프레너관 관통 (올라감)", -2), "앙뜨레프레너관 1층으로 들어가 3층으로 나오기");
  assert.equal(through("향설생활관2 관통", 0), "건물 1층을 통과");
});

test("짧은 꺾임은 앞 단계로 흡수된다", () => {
  const north: [number, number][] = [[36.770, 126.930], [36.772, 126.930]];
  const tinyEast: [number, number][] = [[36.772, 126.930], [36.772, 126.9301]]; // 약 9m
  const s = buildSteps(route([
    { kind: "footway", pts: north, sec: 60, m: 90 },
    { kind: "footway", pts: tinyEast, sec: 8, m: 9 },
  ]), "A", "B");
  assert.equal(s.filter((x) => x.kind === "right").length, 0, "9m 짜리 꺾임은 단계가 되면 안 된다");
  const straight = s.find((x) => x.kind === "straight")!;
  assert.equal(straight.meters, 99, "흡수된 거리가 더해진다");
  assert.equal(straight.seconds, 68, "흡수된 시간도 더해진다");
});
