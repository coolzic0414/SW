/**
 * 첫 화면 디자인 시안 (버릴 수 있는 시험작). 주소에 ?look=a|b|c 를 붙였을 때만 동작한다.
 *   a — 우리 학교 전용 지도: 캠퍼스 밖을 흐리게 가리고 건물만 또렷하게
 *   b — 살아 움직이는 지도: 현재 위치에서 자주 가는 곳들로 길이 차례로 뻗어 나감
 *   c — 큰 글씨 첫 화면: 왼쪽 패널을 전광판처럼
 *   d — 걸어서 몇 분 지도: 건물을 지금 위치에서 걸리는 시간으로 색칠, 가까운 곳부터 물결처럼
 *   e — 날아 들어오기 + 입체 건물: 멀리서 캠퍼스로 확대해 들어오고 건물에 그림자
 *   f — 걷는 사람들: 자주 가는 곳으로 가는 길 위를 점들이 계속 걸어감
 *   g — 오프닝: 날아 들어오기 → 내 위치에서 레이더 물결 → 길이 뻗어 나감 → 점들이 걸어감
 *   h — E + B: 날아 들어오기 → 건물이 떠오름 → 길이 뻗어 나가며 '몇 분'
 */
import { useEffect, useRef, useState } from "react";
import { buildings, routeFromHere } from "./lib/campus.ts";

export type Look = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | null;
export const LOOK: Look = (() => {
  const v = new URLSearchParams(location.search).get("look");
  if (v === "off") return null;   // ?look=off 로 예전 첫 화면
  return v && "abcdefgh".includes(v) && v.length === 1 ? (v as Look) : "h";   // 기본 첫 화면은 H
})();

/** 걸어서 몇 분 → 색. 가까우면 초록, 멀어질수록 파랑·보라 (iOS 시스템 색) */
export const ISO_STEPS = [
  { max: 3, color: "#34c759", label: "3분 이내" },
  { max: 5, color: "#30b0c7", label: "4–5분" },
  { max: 7, color: "#007aff", label: "6–7분" },
  { max: 9, color: "#5856d6", label: "8–9분" },
  { max: Infinity, color: "#af52de", label: "10분 이상" },
];
const isoColor = (min: number) => ISO_STEPS.find((s) => min <= s.max)!.color;

export interface LookItem { code: string; name: string; color: string; seconds: number | null; meters: number | null;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }

/* ---------------- 캠퍼스 경계 (A) ---------------- */

/** 모든 건물 꼭짓점의 볼록 껍질을 가운데서 조금 키운 것. 캠퍼스 '안' 을 대략 감싼다. */
function campusHull(): [number, number][] {
  const pts = buildings.flatMap((b) => b.polygon).map(([la, lo]) => [lo, la] as [number, number]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length, cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([x, y]) => [cy + (y - cy) * 1.1, cx + (x - cx) * 1.1]);
}

export function useLookOverlays(map: any, look: Look, o: {
  active: boolean; here: [number, number] | null; side: boolean; dark: boolean; items: LookItem[];
  /** 현재 위치를 아직 찾는 중인가. 찾는 도중에 날기 시작하면 위치가 도착하는 순간 연출이 끊긴다. */
  waiting?: boolean;
}) {
  // 위치를 3초까지만 기다린다. 그 뒤엔 위치 없이(길 없이) 날아 들어온다.
  const [patience, setPatience] = useState(false);
  useEffect(() => { const t = setTimeout(() => setPatience(true), 3000); return () => clearTimeout(t); }, []);
  // 기다려야 하는가. 이 값이 바뀔 때만 다시 그린다 — 3초 타이머가 이미 위치를 받은 뒤에 끝나도 연출을 건드리지 않게.
  const blocked = !!o.waiting && !patience;
  const drawn = useRef<any[]>([]);
  // 날아 들어오기는 페이지를 연 뒤 처음 한 번만. 목적지를 지웠다 돌아오거나 걸어서 위치가 바뀌면 바로 보여준다.
  const flown = useRef(false);
  const timers = useRef<number[]>([]);
  const itemsKey = o.items.map((i) => i.code + i.seconds).join();

  useEffect(() => {
    const clear = () => {
      const el = document.querySelector<HTMLElement>(".map-tiles");
      if (el) { el.style.transition = ""; el.style.transform = ""; el.classList.remove("flying"); }
      drawn.current.forEach((x) => x.setMap(null)); drawn.current = [];
      timers.current.forEach((t) => { clearTimeout(t); cancelAnimationFrame(t); }); timers.current = [];
    };
    clear();
    const tiles = document.querySelector<HTMLElement>(".map-tiles");
    if (!map || !look || !o.active) { tiles?.classList.remove("opening"); return clear; }
    if (look === "h" && blocked && !flown.current) return clear;   // 위치를 기다리는 중 (지도는 숨긴 채)
    const { kakao } = window;
    const LL = (p: [number, number]) => new kakao.maps.LatLng(p[0], p[1]);
    const add = (x: any) => { x.setMap(map); drawn.current.push(x); return x; };

    /** 캠퍼스 밖을 덮고, 안도 한 겹 옅게 덮는다 (A·D·E 공통) */
    const veil = (hull: [number, number][], light = false) => {
      const [cla, clo] = [hull.reduce((s, p) => s + p[0], 0) / hull.length, hull.reduce((s, p) => s + p[1], 0) / hull.length];
      const R = 0.05;
      const outer: [number, number][] = [[cla + R, clo - R], [cla + R, clo + R], [cla - R, clo + R], [cla - R, clo - R]];
      // light: 원래 지도가 보이게 바깥만 옅게 덮고, 캠퍼스 안은 덮지 않는다 (H)
      add(new kakao.maps.Polygon({ path: [outer.map(LL), hull.map(LL)], strokeWeight: 0,
        fillColor: o.dark ? "#000000" : "#eef0f4", fillOpacity: light ? (o.dark ? 0.3 : 0.38) : (o.dark ? 0.62 : 0.82), zIndex: 1 }));
      if (!light) add(new kakao.maps.Polygon({ path: hull.map(LL), strokeWeight: 0,
        fillColor: o.dark ? "#000000" : "#ffffff", fillOpacity: o.dark ? 0.35 : 0.72, zIndex: 1 }));
    };
    const fit = (pts: [number, number][], pad = 40) => {
      const bounds = new kakao.maps.LatLngBounds(); pts.forEach((p) => bounds.extend(LL(p)));
      map.setBounds(bounds, pad, pad + 20, pad, o.side ? 440 : pad);
    };
    const later = (ms: number, f: () => void) => { timers.current.push(window.setTimeout(f, ms)); };

    /**
     * 착륙 위치를 '보이는 지도 가운데'에 맞추기 위한 화면 밀어내기(px).
     * PC: 왼쪽 패널(400px) 절반만큼 오른쪽. 폰: 아래 시트(화면의 약 25%) 절반만큼 위쪽.
     */
    const shift = () => o.side ? { dx: 200, dy: 0 } : { dx: 0, dy: -Math.round(window.innerHeight * 0.255 / 2) };
    /** PC 는 3단계까지, 폰은 화면이 좁아 4단계까지만 들어간다 (캠퍼스 길 다섯 개가 다 보이게) */
    const LAND = o.side ? 3 : 4;
    /** target 이 '보이는 지도 가운데'에 오도록 level 에서 중심을 잡는다. 즉시, 애니메이션 없이. */
    const placeOn = (m: any, target: [number, number], level: number) => {
      m.setLevel(level);
      m.setCenter(LL(target));
      const { dx, dy } = shift();
      if (!dx && !dy) return;
      const proj = m.getProjection();
      const c = proj.containerPointFromCoords(LL(target));
      m.setCenter(proj.coordsFromContainerPoint(new kakao.maps.Point(c.x - dx, c.y - dy)));
    };
    const place = (target: [number, number], level: number) => placeOn(map, target, level);

    /**
     * 멀리서 날아 들어오기.
     * 카카오의 확대 애니메이션은 단계마다 지도 그림(타일)을 새로 받아서 끊기고 빈 칸이 섞인다.
     * 그래서 두 단계 먼 지도 그림이 다 받아진 뒤, 그 화면을 브라우저가 4배로 매끄럽게 키우고(그래픽 카드가 처리),
     * 다 키운 순간 진짜 착륙 단계 지도로 바꿔 끼운다. 카카오 단계는 한 단계에 2배라 두 단계는 정확히 4배다.
     * 처음 한 번만 날고, 그 뒤엔 바로 착륙 상태로 보여준다.
     */
    const flyIn = (target: [number, number], onLand: () => void) => {
      const el = document.querySelector<HTMLElement>(".map-tiles");
      if (flown.current || !el) { el?.classList.remove("opening"); place(target, LAND); later(0, onLand); return; }
      flown.current = true;
      place(target, LAND + 2);
      /*
       * 착륙할 자리(가까운 지도)를 같은 크기의 두 번째 지도로 미리 받아 둔다.
       * 먼 지도만 4배로 키우면 끝 무렵 글자·길이 4배로 굵어져 '너무 깊이 들어갔다가 나오는' 느낌이 난다.
       * 그래서 확대 후반부에 가까운 지도를 1/4 크기에서 제 크기로 키우며 겹쳐 나타나게 한다.
       * 둘은 같은 기준점·같은 곡선으로 움직여 비율이 늘 4:1 이라 위치가 어긋나지 않는다.
       */
      const ghost = document.createElement("div");
      ghost.className = "map-ghost";
      ghost.style.cssText = "position:absolute;inset:0;opacity:0;pointer-events:none;z-index:1";
      el.after(ghost);
      drawn.current.push({ setMap: () => ghost.remove() });   // 중간에 화면이 바뀌어도 치워지게
      const pre = new kakao.maps.Map(ghost, { center: LL(target), level: LAND });
      placeOn(pre, target, LAND);
      let need = 2;   // 먼 지도와 가까운 지도 둘 다 준비되면 출발
      const ready = () => { if (--need === 0) go(); };
      kakao.maps.event.addListener(pre, "tilesloaded", ready);
      later(2500, () => { need = 0; go(); });   // 너무 오래 걸리면 그냥 출발
      let started = false;
      const DUR = 1400, CURVE = "cubic-bezier(.45,0,.2,1)";
      const go = () => {
        if (started) return; started = true;
        kakao.maps.event.removeListener(map, "tilesloaded", ready);
        const W = el.clientWidth, H = el.clientHeight, { dx, dy } = shift();
        const origin = `${W / 2 + dx}px ${H / 2 + dy}px`;
        el.classList.add("flying");
        for (const [node, from] of [[el, "scale(1)"], [ghost, "scale(0.25)"]] as const) {
          node.style.transformOrigin = origin; node.style.transition = "none"; node.style.transform = from;
        }
        void el.offsetWidth;
        el.style.transition = `transform ${DUR}ms ${CURVE}, opacity .35s ease`; el.style.transform = "scale(4)";
        el.classList.remove("opening");   // 숨겨 두었던 지도가 날기 시작하며 나타난다
        // 먼 지도 글자가 2.5배 넘게 부풀기 전에 가까운 지도로 넘어가게 앞쪽에서 겹친다
        ghost.style.transition = `transform ${DUR}ms ${CURVE}, opacity ${DUR * 0.32}ms ease ${DUR * 0.26}ms`;
        ghost.style.transform = "scale(1)"; ghost.style.opacity = "1";
        later(DUR + 20, () => {
          // 진짜 지도를 착륙 단계로 바꾸고, 그림이 채워질 동안 가까운 지도를 잠깐 더 덮어 두었다가 걷어낸다
          el.style.transition = "none"; place(target, LAND); el.style.transform = ""; el.classList.remove("flying");
          later(80, onLand);
          // 진짜 지도 그림이 다 채워진 뒤에 걷어낸다 (늦어도 1.5초)
          let lifted = false;
          const lift = () => {
            if (lifted) return; lifted = true;
            kakao.maps.event.removeListener(map, "tilesloaded", lift);
            ghost.style.transition = "opacity .25s ease"; ghost.style.opacity = "0";
            later(300, () => ghost.remove());
          };
          kakao.maps.event.addListener(map, "tilesloaded", lift);
          later(1500, lift);
        });
      };
      kakao.maps.event.addListener(map, "tilesloaded", ready);
      later(1200, () => { if (need === 2) ready(); });   // 먼 지도 그림이 이미 다 받아져 있으면 이벤트가 안 올 수 있다
    };

    /** 건물을 띄운다: 남동쪽으로 그림자, 북쪽으로 살짝 올린 지붕, 이름표 */
    const raise = (step = 35, skip: Set<string> = new Set(), see = false) => {
      const SH: [number, number] = [-0.000028, 0.000034], UP = 0.000022;
      buildings.filter((b) => b.polygon.length >= 3)
        .sort((x, y) => y.center[0] - x.center[0])
        .forEach((b, i) => later(i * step, () => {
          // see: 아래 원래 지도(길·건물 이름)가 비치도록 반투명으로 (H)
          add(new kakao.maps.Polygon({ path: b.polygon.map(([la, lo]) => LL([la + SH[0], lo + SH[1]])), strokeWeight: 0,
            fillColor: "#1c2333", fillOpacity: see ? (o.dark ? 0.35 : 0.14) : (o.dark ? 0.5 : 0.22), zIndex: 2 }));
          if (!see) add(new kakao.maps.Polygon({ path: b.polygon.map(LL), strokeWeight: 0, fillColor: o.dark ? "#3a4252" : "#b9c3d6", fillOpacity: 1, zIndex: 3 }));
          add(new kakao.maps.Polygon({ path: b.polygon.map(([la, lo]) => LL([la + UP, lo])), strokeWeight: 1.4,
            strokeColor: o.dark ? "#7d8799" : "#7f8ca6", strokeOpacity: see ? 0.8 : 1,
            fillColor: o.dark ? "#2c3442" : "#eef2f9", fillOpacity: see ? 0.18 : 1, zIndex: 4 }));
          // '몇 분' 말풍선이 붙는 건물은 이름표를 빼서 이름이 두 번 보이지 않게
          if (!see && !skip.has(b.code)) add(new kakao.maps.CustomOverlay({ position: LL([b.center[0] + UP, b.center[1]]), yAnchor: 0.5, zIndex: 5,
            content: `<div class="campus-label rise">${b.name.replace(/^SCH/, "")}</div>` }));
        }));
    };

    /** 지금 위치에서 자주 가는 곳들로 길이 차례로 뻗어 나가고 도착지에 '몇 분' (B) */
    const sprout = (here: [number, number], start0: number) => {
      o.items.forEach((it, i) => {
        const r = routeFromHere(here, it.code);
        if (!r) return;
        const pts = r.path, start = start0 + i * 240, DUR = 850;
        later(start, () => {
          const edge = add(new kakao.maps.Polyline({ path: [], strokeWeight: 9, strokeColor: "#ffffff", strokeOpacity: 0.95, zIndex: 6 }));
          const line = add(new kakao.maps.Polyline({ path: [], strokeWeight: 5, strokeColor: it.color, strokeOpacity: 0.95, zIndex: 7 }));
          const t0 = performance.now();
          const tick = (now: number) => {
            const p = Math.min(1, (now - t0) / DUR);
            const n = Math.max(2, Math.ceil((1 - Math.pow(1 - p, 3)) * pts.length));
            const path = pts.slice(0, n).map(LL); edge.setPath(path); line.setPath(path);
            if (p < 1) timers.current.push(requestAnimationFrame(tick) as unknown as number);
          };
          timers.current.push(requestAnimationFrame(tick) as unknown as number);
          add(new kakao.maps.CustomOverlay({ position: LL(pts[pts.length - 1]), yAnchor: 1.15, zIndex: 9,
            content: `<div class="eta-pin" style="--c:${it.color};animation-delay:${DUR / 1000}s"><i></i>${it.name}<b>${
              it.seconds !== null ? Math.max(1, Math.round(it.seconds / 60)) + "분" : ""}</b></div>` }));
        });
      });
    };
    const centerOf = (pts: [number, number][]): [number, number] => {
      const la = pts.map((p) => p[0]), lo = pts.map((p) => p[1]);
      return [(Math.min(...la) + Math.max(...la)) / 2, (Math.min(...lo) + Math.max(...lo)) / 2];
    };

    if (look === "h") {
      const here = o.here, hull = campusHull();
      // 위치를 못 받으면(권한 거부·캠퍼스 밖) 길 없이 캠퍼스로 날아 들어와 건물만 띄운다
      const paths = here ? o.items.flatMap((it) => routeFromHere(here, it.code)?.path ?? []) : [];
      const again = flown.current;
      flyIn(here && paths.length ? centerOf([here, ...paths]) : centerOf(hull), () => {
        veil(hull, true);
        raise(again ? 0 : 25, new Set(here ? o.items.map((i) => i.code) : []), true);
        if (here) sprout(here, again ? 0 : 500);
      });
    }

    if (look === "d" && o.here) {
      const hull = campusHull(); veil(hull);
      const here = o.here;
      const rows = buildings.filter((b) => b.polygon.length >= 3).map((b) => {
        const r = routeFromHere(here, b.code);
        return { b, min: r ? Math.max(1, Math.round(r.seconds / 60)) : null };
      }).filter((x) => x.min !== null) as { b: typeof buildings[number]; min: number }[];
      rows.sort((x, y) => x.min - y.min);
      // 가까운 건물부터 물결처럼 칠한다
      rows.forEach(({ b, min }, i) => later(200 + min * 140 + i * 12, () => {
        const c = isoColor(min);
        add(new kakao.maps.Polygon({ path: b.polygon.map(LL), strokeWeight: 2, strokeColor: c, strokeOpacity: 1,
          fillColor: c, fillOpacity: o.dark ? 0.55 : 0.42, zIndex: 3 }));
        add(new kakao.maps.CustomOverlay({ position: LL(b.center), yAnchor: 0.5, zIndex: 5,
          content: `<div class="iso-label" style="--c:${c}"><span>${b.name.replace(/^SCH/, "")}</span><b>${min}<small>분</small></b></div>` }));
      }));
      fit(hull);
    }

    if (look === "e") {
      const hull = campusHull();
      flyIn(centerOf(hull), () => { veil(hull); raise(); });
    }

    if (look === "f" && o.here) {
      const all: [number, number][] = [o.here];
      const walkers: { pts: [number, number][]; len: number[]; dots: any[] }[] = [];
      o.items.forEach((it) => {
        const r = routeFromHere(o.here!, it.code);
        if (!r) return;
        const pts = r.path; all.push(...pts);
        add(new kakao.maps.Polyline({ path: pts.map(LL), strokeWeight: 7, strokeColor: "#ffffff", strokeOpacity: 0.9, zIndex: 3 }));
        add(new kakao.maps.Polyline({ path: pts.map(LL), strokeWeight: 3, strokeColor: it.color, strokeOpacity: 0.55, zIndex: 4 }));
        const len = [0];
        for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], (pts[k][1] - pts[k - 1][1]) * 0.8));
        const dots = [0, 1, 2].map(() => add(new kakao.maps.CustomOverlay({ position: LL(pts[0]), yAnchor: 0.5, zIndex: 5,
          content: `<div class="walker" style="--c:${it.color}"></div>` })));
        walkers.push({ pts, len, dots });
        add(new kakao.maps.CustomOverlay({ position: LL(pts[pts.length - 1]), yAnchor: 1.15, zIndex: 6,
          content: `<div class="eta-pin" style="--c:${it.color}"><i></i>${it.name}<b>${it.seconds !== null ? Math.max(1, Math.round(it.seconds / 60)) + "분" : ""}</b></div>` }));
      });
      // 걷는 속도는 실제와 상관없이 보기 좋은 속도. 길이에 비례해 같은 속도로 걷는다.
      const SPEED = 0.00006; // 도(°)/초 ≈ 6m/s
      const t0 = performance.now();
      const at = (w: typeof walkers[number], d: number): [number, number] => {
        const L = w.len[w.len.length - 1]; d = ((d % L) + L) % L;
        let k = 1; while (k < w.len.length - 1 && w.len[k] < d) k++;
        const t = (d - w.len[k - 1]) / Math.max(1e-9, w.len[k] - w.len[k - 1]);
        return [w.pts[k - 1][0] + (w.pts[k][0] - w.pts[k - 1][0]) * t, w.pts[k - 1][1] + (w.pts[k][1] - w.pts[k - 1][1]) * t];
      };
      const tick = (now: number) => {
        const d = ((now - t0) / 1000) * SPEED;
        for (const w of walkers) {
          const L = w.len[w.len.length - 1];
          w.dots.forEach((dot, j) => dot.setPosition(LL(at(w, d + (L * j) / 3))));
        }
        timers.current.push(requestAnimationFrame(tick) as unknown as number);
      };
      timers.current.push(requestAnimationFrame(tick) as unknown as number);
      const bounds = new kakao.maps.LatLngBounds(); all.forEach((p) => bounds.extend(LL(p)));
      map.setBounds(bounds, 80, 80, 60, o.side ? 470 : 60);
    }

    if (look === "g" && o.here) {
      const here = o.here;
      const routes = o.items.map((it) => ({ it, r: routeFromHere(here, it.code) })).filter((x) => x.r) as
        { it: LookItem; r: NonNullable<ReturnType<typeof routeFromHere>> }[];
      const all: [number, number][] = [here, ...routes.flatMap((x) => x.r.path)];
      const bounds = new kakao.maps.LatLngBounds(); all.forEach((p) => bounds.extend(LL(p)));
      // 1) 멀리서 날아 들어온다. 이후 순서는 착륙한 때부터 센다.
      const queue: [number, () => void][] = [];
      const afterLand = (ms: number, f: () => void) => queue.push([ms, f]);
      void bounds;
      // 2) 내 위치에서 레이더 물결 두 번
      [200, 550].forEach((ms) => afterLand(ms, () => {
        const ring = add(new kakao.maps.Circle({ center: LL(here), radius: 1, strokeWeight: 2, strokeColor: "#007aff",
          strokeOpacity: 0.8, fillColor: "#007aff", fillOpacity: 0.18, zIndex: 2 }));
        const t0 = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - t0) / 1100), e = 1 - Math.pow(1 - p, 3);
          ring.setRadius(10 + e * 260);
          ring.setOptions({ strokeOpacity: 0.8 * (1 - p), fillOpacity: 0.18 * (1 - p) });
          if (p < 1) timers.current.push(requestAnimationFrame(tick) as unknown as number); else ring.setMap(null);
        };
        timers.current.push(requestAnimationFrame(tick) as unknown as number);
      }));
      // 3) 길이 차례로 뻗어 나가고 도착지에 말풍선
      const lines: { pts: [number, number][]; len: number[]; it: LookItem }[] = [];
      routes.forEach(({ it, r }, i) => {
        const pts = r.path;
        const start = 800 + i * 220, DUR = 800;
        afterLand(start, () => {
          const edge = add(new kakao.maps.Polyline({ path: [], strokeWeight: 9, strokeColor: "#ffffff", strokeOpacity: 0.95, zIndex: 3 }));
          const line = add(new kakao.maps.Polyline({ path: [], strokeWeight: 5, strokeColor: it.color, strokeOpacity: 0.95, zIndex: 4 }));
          const t0 = performance.now();
          const tick = (now: number) => {
            const p = Math.min(1, (now - t0) / DUR);
            const n = Math.max(2, Math.ceil((1 - Math.pow(1 - p, 3)) * pts.length));
            const path = pts.slice(0, n).map(LL); edge.setPath(path); line.setPath(path);
            if (p < 1) timers.current.push(requestAnimationFrame(tick) as unknown as number);
          };
          timers.current.push(requestAnimationFrame(tick) as unknown as number);
          add(new kakao.maps.CustomOverlay({ position: LL(pts[pts.length - 1]), yAnchor: 1.15, zIndex: 6,
            content: `<div class="eta-pin" style="--c:${it.color};animation-delay:${DUR / 1000}s"><i></i>${it.name}<b>${
              it.seconds !== null ? Math.max(1, Math.round(it.seconds / 60)) + "분" : ""}</b></div>` }));
        });
        const len = [0];
        for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], (pts[k][1] - pts[k - 1][1]) * 0.8));
        lines.push({ pts, len, it });
      });
      // 4) 길 위를 점들이 걷는다
      afterLand(800 + routes.length * 220 + 900, () => {
        const walkers = lines.map((w) => ({ ...w, dots: [0, 1, 2].map(() => add(new kakao.maps.CustomOverlay({
          position: LL(w.pts[0]), yAnchor: 0.5, zIndex: 5, content: `<div class="walker" style="--c:${w.it.color}"></div>` }))) }));
        const at = (w: typeof walkers[number], d: number): [number, number] => {
          const L = w.len[w.len.length - 1]; d = ((d % L) + L) % L;
          let k = 1; while (k < w.len.length - 1 && w.len[k] < d) k++;
          const t = (d - w.len[k - 1]) / Math.max(1e-9, w.len[k] - w.len[k - 1]);
          return [w.pts[k - 1][0] + (w.pts[k][0] - w.pts[k - 1][0]) * t, w.pts[k - 1][1] + (w.pts[k][1] - w.pts[k - 1][1]) * t];
        };
        const t0 = performance.now();
        const tick = (now: number) => {
          const d = ((now - t0) / 1000) * 0.00005;
          for (const w of walkers) { const L = w.len[w.len.length - 1]; w.dots.forEach((dot, j) => dot.setPosition(LL(at(w, d + (L * j) / 3)))); }
          timers.current.push(requestAnimationFrame(tick) as unknown as number);
        };
        timers.current.push(requestAnimationFrame(tick) as unknown as number);
      });
          flyIn(centerOf(all), () => queue.forEach(([ms, f]) => later(ms, f)));
    }

    if (look === "a") {
      const hull = campusHull();
      const [cla, clo] = [hull.reduce((s, p) => s + p[0], 0) / hull.length, hull.reduce((s, p) => s + p[1], 0) / hull.length];
      const R = 0.05;
      const outer: [number, number][] = [[cla + R, clo - R], [cla + R, clo + R], [cla - R, clo + R], [cla - R, clo - R]];
      // 바깥은 덮고 캠퍼스만 구멍 — 주변 동네가 물러나고 학교만 남는다
      add(new kakao.maps.Polygon({
        path: [outer.map(LL), hull.map(LL)], strokeWeight: 0,
        fillColor: o.dark ? "#000000" : "#eef0f4", fillOpacity: o.dark ? 0.62 : 0.82, zIndex: 1,
      }));
      // 캠퍼스 안도 한 겹 옅게 덮어 카카오 원래 글자(건물 이름)를 누른다 — 우리 이름표와 겹쳐 두 번 보이지 않게
      add(new kakao.maps.Polygon({
        path: hull.map(LL), strokeWeight: 0,
        fillColor: o.dark ? "#000000" : "#ffffff", fillOpacity: o.dark ? 0.35 : 0.72, zIndex: 1,
      }));
      for (const b of buildings) {
        if (b.polygon.length < 3) continue;
        add(new kakao.maps.Polygon({
          path: b.polygon.map(LL), strokeWeight: 1.5, strokeColor: o.dark ? "#6b7383" : "#8f9bb3", strokeOpacity: 1,
          fillColor: o.dark ? "#2c3442" : "#dfe6f3", fillOpacity: 1, zIndex: 3,
        }));
        add(new kakao.maps.CustomOverlay({
          position: LL(b.center), yAnchor: 0.5, zIndex: 4,
          content: `<div class="campus-label">${b.name.replace(/^SCH/, "")}</div>`,
        }));
      }
      map.setLevel(3);
      const bounds = new kakao.maps.LatLngBounds(); hull.forEach((p) => bounds.extend(LL(p)));
      map.setBounds(bounds, 40, 60, 40, o.side ? 440 : 40);
    }

    if (look === "b" && o.here) {
      const all: [number, number][] = [o.here];
      o.items.forEach((it, i) => {
        const r = routeFromHere(o.here!, it.code);
        if (!r) return;
        const pts = r.path; all.push(...pts);
        const edge = add(new kakao.maps.Polyline({ path: [], strokeWeight: 9, strokeColor: "#ffffff", strokeOpacity: 0.95, zIndex: 3 }));
        const line = add(new kakao.maps.Polyline({ path: [], strokeWeight: 5, strokeColor: it.color, strokeOpacity: 0.95, zIndex: 4 }));
        const start = 250 + i * 260, DUR = 900;
        const t0 = performance.now() + start;
        const tick = (now: number) => {
          const p = Math.max(0, Math.min(1, (now - t0) / DUR));
          const n = Math.max(2, Math.ceil((1 - Math.pow(1 - p, 3)) * pts.length));
          const path = pts.slice(0, n).map(LL);
          edge.setPath(path); line.setPath(path);
          if (p < 1) timers.current.push(requestAnimationFrame(tick) as unknown as number);
        };
        timers.current.push(requestAnimationFrame(tick) as unknown as number);
        const end = pts[pts.length - 1];
        add(new kakao.maps.CustomOverlay({
          position: LL(end), yAnchor: 1.15, zIndex: 6,
          content: `<div class="eta-pin" style="--c:${it.color};animation-delay:${(start + DUR) / 1000}s">
                      <i></i>${it.name}<b>${it.seconds !== null ? Math.max(1, Math.round(it.seconds / 60)) + "분" : ""}</b></div>`,
        }));
      });
      const bounds = new kakao.maps.LatLngBounds(); all.forEach((p) => bounds.extend(LL(p)));
      map.setBounds(bounds, 80, 80, 60, o.side ? 470 : 60);
    }
    return clear;
  }, [map, look, o.active, o.here?.[0], o.here?.[1], o.side, o.dark, itemsKey, blocked]);
}

/* ---------------- 큰 글씨 첫 화면 (C) ---------------- */

export function HeroPanel({ items, onPick, sub }: { items: LookItem[]; onPick: (name: string) => void; sub: string }) {
  const now = new Date();
  const hh = now.getHours(), mm = String(now.getMinutes()).padStart(2, "0");
  const clock = `${hh < 12 ? "오전" : "오후"} ${((hh + 11) % 12) + 1}:${mm}`;
  const arrive = (sec: number) => {
    const d = new Date(Date.now() + sec * 1000);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} 도착`;
  };
  return (
    <div className="pt-1">
      <p className="text-[13px] font-semibold text-primary">{clock} · {sub}</p>
      <h2 className="mt-1.5 text-[40px] leading-[1.08] font-extrabold tracking-[-0.035em]">어디로<br />갈까요?</h2>
      <ol className="mt-5 overflow-hidden rounded-2xl bg-card">
        {items.map((q, i) => (
          <li key={q.code}>
            <button onClick={() => onPick(q.name)}
                    className={`hero-row flex w-full items-center gap-3 px-3.5 py-3 text-left active:bg-muted ${i ? "border-t" : ""}`}
                    style={{ animationDelay: `${120 + i * 70}ms` }}>
              <span className="grid size-10 shrink-0 place-items-center rounded-full text-white" style={{ background: q.color }}>
                <q.Icon className="size-5" strokeWidth={2.3} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-semibold">{q.name}</span>
                <span className="num block text-[13px] text-muted-foreground">
                  {q.seconds !== null ? `${q.meters}m · ${arrive(q.seconds)}` : "위치 확인 중"}
                </span>
              </span>
              {q.seconds !== null && (
                <span className="num shrink-0 text-right">
                  <b className="text-[32px] leading-none font-extrabold tracking-[-0.04em]">{Math.max(1, Math.round(q.seconds / 60))}</b>
                  <span className="ml-0.5 text-[15px] font-semibold text-muted-foreground">분</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      <p className="mt-3 px-1 text-[12.5px] text-muted-foreground">실제로 걷는 캠퍼스 길과 건물 출입구로 계산한 시간입니다.</p>
    </div>
  );
}

/* ---------------- 걸어서 몇 분 범례 (D) ---------------- */

export function IsoLegend({ side }: { side: boolean }) {
  return (
    <div className={`glass absolute z-10 flex items-center gap-3 rounded-full px-4 py-2 text-[12.5px] font-semibold
                     ${side ? "bottom-10 left-[calc(50%+200px)] -translate-x-1/2" : "top-[110px] left-1/2 -translate-x-1/2"}`}>
      <span className="text-muted-foreground">지금 위치에서 걸어서</span>
      {ISO_STEPS.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <i className="size-2.5 rounded-full" style={{ background: s.color }} />{s.label}
        </span>
      ))}
    </div>
  );
}
