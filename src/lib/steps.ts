/**
 * 경로를 사람이 따라갈 수 있는 단계로 쪼갠다.
 *
 * 길찾기 앱에서 사용자가 실제로 보는 건 "3분 40초"가 아니라
 * "직진 40초 → 오른쪽 → 공학관 1층 통과" 목록이다. 요약은 결정용, 목록은 수행용이다.
 */
import type { CampusRoute } from "./campus.ts";

export type StepKind = "start" | "straight" | "left" | "right" | "through" | "approach" | "arrive";

export interface Step {
  kind: StepKind;
  text: string;
  seconds: number;
  meters: number;
}

const R = Math.PI / 180;

/** 두 좌표 사이 방위각(도). 북쪽 0, 시계방향. */
export function bearing(a: [number, number], b: [number, number]): number {
  const dy = b[0] - a[0];
  const dx = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * R);
  return (Math.atan2(dx, dy) / R + 360) % 360;
}

/** -180 ~ 180 으로 정규화한 방향 변화량 */
export function turnDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** 꺾임이 이 각도보다 작으면 직진으로 본다. 캠퍼스 길은 완만해서 넉넉히 잡는다. */
const STRAIGHT_LIMIT = 35;

/** 받침 있으면 '으로', 없거나 ㄹ 받침이면 '로' (정문으로, 연결통로로) */
export const ro = (word: string) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  if (c < 0 || c > 11171) return "로";
  const jong = c % 28;
  return jong === 0 || jong === 8 ? "로" : "으로";
};

export function buildSteps(route: CampusRoute, fromName: string, toName: string): Step[] {
  // 건물 안에서 출발하면 '어느 문으로 나가는지' 가 첫 안내다. 건물 안 어디 있든 그 문이 목적지에 가장 빠르다.
  const startText = route.exitDoor
    ? `${fromName} ${route.exitDoor}${ro(route.exitDoor)} 나가기`
    : `${fromName}에서 출발`;
  const steps: Step[] = [{ kind: "start", text: startText, seconds: 0, meters: 0 }];

  let prevBearing: number | null = null;

  route.segments.forEach((seg, i) => {
    const e = route.edges[i];
    if (!e || seg.points.length < 2) return;

    const head = seg.points[0];
    const next = seg.points[1];
    const b = bearing(head, next);
    const delta = prevBearing === null ? 0 : turnDelta(prevBearing, b);

    let kind: StepKind;
    let text: string;

    if (seg.kind === "through_building") {
      kind = "through";
      text = "건물 1층을 통과";
    } else if (seg.kind === "approach") {
      kind = "approach";
      text = i === 0 ? "건물 밖으로 나와 길까지" : "건물 앞까지";
    } else if (Math.abs(delta) <= STRAIGHT_LIMIT) {
      kind = "straight";
      text = "직진";
    } else {
      kind = delta > 0 ? "right" : "left";
      text = delta > 0 ? "오른쪽으로" : "왼쪽으로";
    }

    const last = steps[steps.length - 1];
    // 같은 성격이 이어지면 한 단계로 합친다. 열 걸음마다 "직진"이 뜨면 못 읽는다.
    if (last.kind === kind && (kind === "straight" || kind === "through" || kind === "approach")) {
      last.seconds += e.seconds;
      last.meters += e.meters;
    } else {
      steps.push({ kind, text, seconds: e.seconds, meters: e.meters });
    }

    // 다음 꺾임은 이 구간의 끝 방향을 기준으로 잰다
    const tail = seg.points[seg.points.length - 2] ?? head;
    prevBearing = bearing(tail, seg.points[seg.points.length - 1]);
  });

  steps.push({ kind: "arrive", text: `${toName} 도착`, seconds: 0, meters: 0 });

  return merged(steps).map((s) => ({
    ...s, seconds: Math.round(s.seconds), meters: Math.round(s.meters),
  }));
}

/** 25m 미만 꺾임은 앞 단계에 흡수시킨다. "오른쪽으로 10m"가 줄줄이 뜨면 아무도 안 읽는다. */
const TOO_SHORT = 25;

function merged(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    const trivial = s.meters > 0 && s.meters < TOO_SHORT && (s.kind === "left" || s.kind === "right");
    if (trivial && prev && prev.kind !== "start") {
      prev.seconds += s.seconds;
      prev.meters += s.meters;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}
