/**
 * 강의실 코드 파서
 *
 * 순천향대는 건물을 부르는 방법이 세 가지이고 서로 호환되지 않는다.
 *   - 캠퍼스맵 위치번호 : C03(공학관), B20(의료과학관)
 *   - 강의실 코드(문자) : U(유니토피아관), ML(SCH미디어랩스관)
 *   - 강의실 코드(숫자) : 9(공학관), 3(자연과학관)
 * 시간표에 찍히는 건 세 번째·두 번째뿐이고, 학생이 아는 것도 그것뿐이다.
 * 이 파서는 학생이 입력한 문자열을 건물·층·호실로 되돌린다.
 */

export interface BuildingEntry {
  code: string;
  name: string;
  aliases: string[];
}

export interface RoomCodeTable {
  buildings: BuildingEntry[];
  non_classroom: { code: string; name: string }[];
}

/**
 * 강의실 코드가 없는 건물 (기숙사·학생회관·식당).
 * 이름으로만 찾는다 — '교직원식당'은 되고 '교직원식당301'은 강의실이 아니라서 안 된다.
 */
export interface LandmarkEntry {
  code: string;
  name: string;
  aliases: string[];
}

export interface RoomCodeIndex {
  /** 긴 코드부터 정렬된 문자 코드 목록. ML325 를 M + L325 로 읽지 않기 위해 필요하다. */
  letterCodes: string[];
  /** 숫자 한 자리로 시작하는 건물 코드 (1,3,5,6,7,9) */
  digitCodes: Set<string>;
  byCode: Map<string, BuildingEntry>;
  /** 별칭·건물명 → 코드. 모두 공백 제거·대문자화된 키 */
  byAlias: Map<string, string>;
  /** 긴 별칭부터 정렬. '향1' 처럼 숫자가 섞인 별칭 때문에 접두어 매칭이 필요하다. */
  aliasKeys: string[];
  nonClassroom: Map<string, string>;
  /** 이름·별칭 → 강의실 없는 건물. 숫자가 붙으면 매칭하지 않는다. */
  landmarks: Map<string, LandmarkEntry>;
}

export type ParseResult =
  | {
      ok: true;
      code: string;
      building: string;
      floor: number | null;
      room: string;
      /** 층을 호실 번호에서 추정했으면 false. 추정은 사용자에게 확인받아야 한다. */
      floorConfirmed: boolean;
      normalized: string;
      /** 오타·초성 등으로 비슷한 곳을 골라 준 경우, 사용자가 실제로 친 말 (campus.parse 가 채운다) */
      typed?: string;
    }
  | { ok: false; reason: "not_classroom"; place: string }
  | { ok: false; reason: "ambiguous"; room: string; candidates: BuildingEntry[] }
  | { ok: false; reason: "unknown"; input: string };

const stripSpace = (s: string) => s.replace(/[\s\-_.]/g, "");

export function buildRoomCodeIndex(
  table: RoomCodeTable,
  landmarkList: LandmarkEntry[] = [],
): RoomCodeIndex {
  const byCode = new Map<string, BuildingEntry>();
  const byAlias = new Map<string, string>();
  const letterCodes: string[] = [];
  const digitCodes = new Set<string>();

  for (const b of table.buildings) {
    byCode.set(b.code, b);
    if (/^\d$/.test(b.code)) digitCodes.add(b.code);
    else letterCodes.push(b.code);

    for (const a of [b.name, ...b.aliases]) {
      byAlias.set(stripSpace(a).toUpperCase(), b.code);
    }
  }
  // 긴 코드 우선 (ML > M, BI > B, RC > R)
  letterCodes.sort((a, b) => b.length - a.length || a.localeCompare(b));

  const aliasKeys = [...byAlias.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));

  const nonClassroom = new Map<string, string>();
  for (const x of table.non_classroom) {
    nonClassroom.set(stripSpace(x.code).toUpperCase(), x.name);
  }
  const landmarks = new Map<string, LandmarkEntry>();
  for (const l of landmarkList) {
    for (const key of [l.name, l.code, ...l.aliases]) {
      landmarks.set(stripSpace(key).toUpperCase(), l);
    }
  }

  return { letterCodes, digitCodes, byCode, byAlias, aliasKeys, nonClassroom, landmarks };
}

/** 호실 숫자에서 층을 뽑는다. 115 -> 1층, 524 -> 5층, 09 -> 알 수 없음 */
function floorFromRoom(room: string): number | null {
  if (room.length < 2) return null;
  const f = Number(room[0]);
  return Number.isFinite(f) && f > 0 ? f : null;
}

export function parseRoomCode(input: string, idx: RoomCodeIndex): ParseResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, reason: "unknown", input: raw };

  const s = stripSpace(raw).toUpperCase();

  // 1) 강의실이 아닌 코드 (운동장·인턴십·타 캠퍼스)
  if (idx.nonClassroom.has(s)) {
    return { ok: false, reason: "not_classroom", place: idx.nonClassroom.get(s)! };
  }

  // 2) 건물명·별칭 + 숫자  ("공학관305", "향1 220", "미랩325")
  //    별칭 자체에 숫자가 들어갈 수 있어(향1) 정규식으로 쪼개면 안 되고,
  //    긴 별칭부터 접두어로 맞춰야 한다.
  for (const alias of idx.aliasKeys) {
    if (!s.startsWith(alias)) continue;
    const rest = s.slice(alias.length);
    if (!/^\d{2,4}$/.test(rest)) continue;
    const code = idx.byAlias.get(alias)!;
    return {
      ok: true,
      code,
      building: idx.byCode.get(code)!.name,
      floor: floorFromRoom(rest),
      room: rest,
      floorConfirmed: false,
      normalized: code + rest,
    };
  }

  // 3) 문자 코드 + 숫자  ("U524", "ML325", "RC220")  — 긴 코드부터
  for (const code of idx.letterCodes) {
    if (!s.startsWith(code)) continue;
    const rest = s.slice(code.length);
    if (!/^\d{2,4}$/.test(rest)) continue;
    return {
      ok: true,
      code,
      building: idx.byCode.get(code)!.name,
      floor: floorFromRoom(rest),
      room: rest,
      floorConfirmed: false,
      normalized: code + rest,
    };
  }

  // 3-1) 건물 이름이나 코드만 ("공학관", "유니토피아", "ML")
  //      호실을 모르고 건물만 아는 경우가 많다. 그때도 길은 알려줘야 한다.
  {
    const code = idx.byAlias.get(s) ?? (idx.byCode.has(s) ? s : undefined);
    if (code) {
      const b = idx.byCode.get(code)!;
      return {
        ok: true,
        code,
        building: b.name,
        floor: null,
        room: "",
        floorConfirmed: true,   // 추정한 층이 없으니 확인할 것도 없다
        normalized: b.name,
      };
    }
  }

  // 3-2) 강의실 없는 건물 ("교직원식당", "향2", "글빌")
  //      강의동 다음에 본다. 이름이 겹치면 강의동이 이긴다.
  {
    const l = idx.landmarks.get(s);
    if (l) {
      return {
        ok: true,
        code: l.code,
        building: l.name,
        floor: null,
        room: "",
        floorConfirmed: true,
        normalized: l.name,
      };
    }
  }

  // 3-3) 이름 일부만 ("BRIX", "미디어랩스", "앙뜨레")
  //      사람들은 'SCH미디어랩스관' 을 다 치지 않는다. 일부가 딱 한 건물에만 들어맞으면 그 건물이다.
  //      '과학관' 처럼 여러 건물에 걸리면 고르지 않는다 — 엉뚱한 건물로 안내하느니 모른다고 하는 게 낫다.
  if (s.length >= 2 && !/^\d+$/.test(s)) {
    const hits = new Map<string, { building: string }>();
    for (const [key, code] of idx.byAlias) {
      if (key.includes(s)) hits.set(code, { building: idx.byCode.get(code)!.name });
    }
    for (const [key, l] of idx.landmarks) {
      if (key.includes(s) && !hits.has(l.code)) hits.set(l.code, { building: l.name });
    }
    if (hits.size === 1) {
      const [[code, { building }]] = [...hits];
      return { ok: true, code, building, floor: null, room: "", floorConfirmed: true, normalized: building };
    }
  }

  // 4) 숫자만  ("9115" = 공학관 1층 15호, "3209" = 자연과학관 2층 09호)
  if (/^\d{4}$/.test(s) && idx.digitCodes.has(s[0])) {
    const code = s[0];
    const room = s.slice(1);
    return {
      ok: true,
      code,
      building: idx.byCode.get(code)!.name,
      floor: floorFromRoom(room),
      room,
      floorConfirmed: false,
      normalized: s,
    };
  }

  // 5) 건물을 특정할 수 없는 숫자 ("305") — 후보를 보여주고 고르게 한다
  if (/^\d{2,3}$/.test(s)) {
    return {
      ok: false,
      reason: "ambiguous",
      room: s,
      candidates: [...idx.byCode.values()],
    };
  }

  return { ok: false, reason: "unknown", input: raw };
}

/** 확인 카드에 쓸 한 줄. "공학관 1층 9115" */
export function describe(r: ParseResult): string {
  if (!r.ok) {
    if (r.reason === "not_classroom") return `${r.place} — 강의실이 아닙니다`;
    if (r.reason === "ambiguous") return `${r.room}호 — 건물을 선택해주세요`;
    return "인식할 수 없는 강의실입니다";
  }
  if (!r.room) return r.building;              // 건물만 지정한 경우
  const floor = r.floor === null ? "" : ` ${r.floor}층`;
  return `${r.building}${floor} ${r.normalized}`;
}
