/**
 * 비슷한 말로 건물 찾기.
 *
 * 학생들은 정확한 이름을 치지 않는다. 오타("공헉관"), 초성("ㄱㅎㄱ"), 한/영 전환을 잊고 친 것("rhdgkrrhks"),
 * 글자를 빠뜨린 것("유토피아"), 일부만 친 것("학생회")을 모두 받아서 가까운 순으로 돌려준다.
 *
 * 한글은 자모 단위(키보드로 누르는 단위)로 쪼개서 비교한다. 그래야 "공헉관"과 "공학관"이
 * 글자 하나가 통째로 다른 게 아니라 'ㅏ↔ㅓ' 한 번 차이로 계산된다.
 */

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const JUNG = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"];
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
/** 겹모음·겹받침을 키 두 번으로 (ㅘ = ㅗ+ㅏ). 두벌식 자판으로 친 것과 비교하려면 키 단위여야 한다. */
const SPLIT: Record<string, string> = {
  "ㅘ": "ㅗㅏ", "ㅙ": "ㅗㅐ", "ㅚ": "ㅗㅣ", "ㅝ": "ㅜㅓ", "ㅞ": "ㅜㅔ", "ㅟ": "ㅜㅣ", "ㅢ": "ㅡㅣ",
  "ㄳ": "ㄱㅅ", "ㄵ": "ㄴㅈ", "ㄶ": "ㄴㅎ", "ㄺ": "ㄹㄱ", "ㄻ": "ㄹㅁ", "ㄼ": "ㄹㅂ", "ㄽ": "ㄹㅅ", "ㄾ": "ㄹㅌ",
  "ㄿ": "ㄹㅍ", "ㅀ": "ㄹㅎ", "ㅄ": "ㅂㅅ",
};
/** 두벌식 자판: 영문 키 → 자모. 한/영 전환을 잊고 친 "rhdgkrrhks" 를 "공학관" 으로 읽는다. */
const KEY: Record<string, string> = {
  q: "ㅂ", w: "ㅈ", e: "ㄷ", r: "ㄱ", t: "ㅅ", y: "ㅛ", u: "ㅕ", i: "ㅑ", o: "ㅐ", p: "ㅔ",
  a: "ㅁ", s: "ㄴ", d: "ㅇ", f: "ㄹ", g: "ㅎ", h: "ㅗ", j: "ㅓ", k: "ㅏ", l: "ㅣ",
  z: "ㅋ", x: "ㅌ", c: "ㅊ", v: "ㅍ", b: "ㅠ", n: "ㅜ", m: "ㅡ",
  Q: "ㅃ", W: "ㅉ", E: "ㄸ", R: "ㄲ", T: "ㅆ", O: "ㅒ", P: "ㅖ",
};

const split = (j: string) => SPLIT[j] ?? j;

/** 비교용으로 다듬기: 공백·기호 빼고 영문은 대문자 */
export const norm = (s: string) => s.replace(/[\s\-_.·()]/g, "").toUpperCase();

/** 한글 음절을 자모(키 단위)로 푼다. 한글이 아닌 글자는 그대로 둔다. */
export function jamo(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c < 11172) {
      out += CHO[Math.floor(c / 588)] + split(JUNG[Math.floor((c % 588) / 28)]) + split(JONG[c % 28]);
    } else out += split(ch);
  }
  return out;
}

/** 초성만 ("공학관" → "ㄱㅎㄱ") */
export function initials(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return out;
}

/** 영문 자판으로 친 것을 자모로. 영문이 아니면 null */
export function fromQwerty(raw: string): string | null {
  const s = raw.replace(/\s/g, "");
  if (!/^[a-zA-Z]{3,}$/.test(s)) return null;
  return [...s].map((c) => KEY[c] ?? KEY[c.toLowerCase()] ?? c).join("");
}

/** 편집 거리 (넣기·빼기·바꾸기 한 번씩 1) */
export function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** a 의 글자가 b 안에 순서대로 다 들어 있는가 (글자를 빠뜨리고 친 경우) */
const isSubseq = (a: string, b: string) => {
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length;
};

export interface Place { code: string; name: string; keys: string[] }
export interface Suggestion {
  code: string;
  name: string;
  /** 검색창에 넣을 말. 호실까지 쳤으면 호실을 붙인다 ("공학관305") */
  fill: string;
  room: string;
  score: number;
}

/** 한 낱말(이름·별칭·코드)이 입력과 얼마나 가까운가. 0 이면 관계없음. */
function scoreKey(q: string, rawQ: string, k: string): number {
  if (!q || !k) return 0;
  if (q === k) return 100;
  if (k.startsWith(q)) return 92 - Math.min(10, k.length - q.length);
  if (q.length >= 2 && k.includes(q)) return 82;
  let best = 0;
  // 초성으로만 친 경우
  if (/^[ㄱ-ㅎ]+$/.test(q) && q.length >= 2) {
    const ik = initials(k);
    if (ik === q) best = Math.max(best, 88);
    else if (ik.startsWith(q)) best = Math.max(best, 84);
    else if (ik.includes(q)) best = Math.max(best, 72);
  }
  const jq = jamo(q), jk = jamo(k);
  if (jq.length >= 3) {
    const thr = jq.length <= 5 ? 1 : jq.length <= 9 ? 2 : 3;
    const d = lev(jq, jk);
    if (d <= thr) best = Math.max(best, 70 - d * 6);                         // 오타
    const dp = lev(jq, jk.slice(0, jq.length));
    if (jq.length >= 4 && dp <= 1) best = Math.max(best, 62 - dp * 6);       // 앞부분만, 오타 하나
    if (jq.length >= 5 && isSubseq(jq, jk) && jq.length >= jk.length * 0.6) best = Math.max(best, 64);   // 글자 빠짐
  }
  // 한/영 전환을 잊고 친 경우
  const qw = fromQwerty(rawQ);
  if (qw) {
    if (qw === jk) best = Math.max(best, 96);
    else if (jk.startsWith(qw) && qw.length >= 4) best = Math.max(best, 86);
    else if (qw.length >= 5 && lev(qw, jk) <= 1) best = Math.max(best, 66);
  }
  return best;
}

/** 입력과 비슷한 장소를 가까운 순으로. 같은 장소는 가장 잘 맞는 낱말 점수 하나만 쓴다. */
export function suggest(input: string, places: Place[], limit = 6): Suggestion[] {
  const raw = input.trim();
  if (!raw) return [];
  let q = norm(raw);
  // 끝에 붙은 호실 번호는 떼어 두었다가 다시 붙인다 ("공헉관305" → 공학관 + 305)
  let room = "";
  const m = q.match(/^(.*\D)(\d{2,4})$/);
  if (m && m[1].length >= 2) { q = m[1]; room = m[2]; }
  const rawBase = room ? raw.replace(/\s*\d{2,4}\s*$/, "") : raw;
  const out: Suggestion[] = [];
  for (const p of places) {
    let s = 0;
    for (const k of p.keys) s = Math.max(s, scoreKey(q, rawBase, norm(k)));
    if (s > 0) out.push({ code: p.code, name: p.name, fill: p.name + room, room, score: s });
  }
  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

/** 맨 위 후보가 분명히 낫다면 그것 하나, 아니면 null. 애매하면 고르지 않는다 — 엉뚱한 건물로 안내하느니 묻는다. */
export function bestGuess(list: Suggestion[], minScore = 58, margin = 8): Suggestion | null {
  if (!list.length || list[0].score < minScore) return null;
  if (list.length > 1 && list[1].score > list[0].score - margin) return null;
  return list[0];
}
