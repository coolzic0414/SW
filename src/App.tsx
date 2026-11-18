import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown, Navigation, MapPin, X,
  CornerUpLeft, CornerUpRight, ArrowUp, DoorOpen, Building2,
  BookOpen, Users, Utensils, Dumbbell, Landmark, Sun, Moon, Zap,
} from "lucide-react";
import { useKakaoMap } from "./useKakaoMap.ts";
import {
  buildings, parse, describe, getBuilding, routeBetween, routeFromHere, formatDuration, nearestBuilding, buildingAt,
  type CampusRoute, type HereRoute,
} from "./lib/campus.ts";
import { buildSteps, ro, type Step, type StepKind } from "./lib/steps.ts";
import type { RouteOptions } from "./lib/graph.ts";
import { Roadview } from "./ui/Roadview.tsx";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const CAMPUS_CENTER: [number, number] = [36.77004, 126.93192];

const token = (n: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#2563eb";

type Theme = "dark" | "light";

/**
 * 기본은 밝은 지도. 실제로 쓰는 곳이 낮의 야외(햇빛 아래)이고, 발표 프로젝터는 어두운 화면을 뭉갠다.
 * 또 어두운 지도는 카카오 타일을 색 반전한 것이라 밝은 쪽이 원본 그대로다.
 * 버튼으로 바꾼 값만 기억한다 — 기본값을 저장해 두면 나중에 기본을 바꿔도 예전 값이 남는다.
 * (키 이름을 바꾼 이유도 그것: 예전 버전이 'theme' 에 기본값 dark 를 자동 저장해 두었다.)
 */
const THEME_KEY = "theme-choice";
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const toggle = () => setTheme((t) => {
    const next = t === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch { /* 사생활 보호 모드 등 — 기억 못 해도 동작은 한다 */ }
    return next;
  });
  return [theme, toggle];
}

/**
 * 넓은 화면(PC·발표용 노트북)에서는 검색·정보를 왼쪽 400px 패널로 띄운다.
 * 폰 배치(위 검색 카드 + 아래 바텀시트)를 그대로 늘리면 숫자가 양 끝으로 벌어진다.
 * 구글·네이버·카카오 지도 웹도 왼쪽 패널 + 지도다. (Behance 'Store Finder Concept' 참고)
 */
function useSideLayout() {
  const q = "(min-width: 900px)";
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setWide(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return wide;
}

/** 지름길이 이만큼은 빨라야 '단축' 이라고 내세운다. 몇 초 차이를 자랑하면 오히려 신뢰가 깎인다. */
const SHORTCUT_MIN_SAVED = 20;

/** 관통 엣지 노드 id 는 `ds:<건물코드>:<번호>-<문>` — 어느 건물을 지나는지 여기서 꺼낸다. */
const crossedBuildings = (r: CampusRoute) => [
  ...new Set(r.edges.filter((e) => e.kind === "through_building").map((e) => e.from.split(":")[1])),
];

/** 출발지 '현재 위치' 를 뜻하는 값. 건물 코드와 안 겹치게 @ 로 시작한다. */
const HERE = "@here";
/** 캠퍼스 중심에서 이보다 멀면 캠퍼스 밖으로 본다 (캠퍼스 폭이 700m 남짓) */
const CAMPUS_RADIUS = 1200;

type HereStatus = "finding" | "ok" | "denied" | "far" | "unsupported";

/**
 * 현재 위치를 계속 받아온다. 걸어가면서 출발점이 따라 움직여야 하니 한 번이 아니라 watch.
 * 위치가 몇 m 바뀔 때마다 경로를 다시 계산하면 화면이 계속 깜빡이므로 8m 넘게 움직였을 때만 갱신한다.
 */
function useHere() {
  const [here, setHere] = useState<[number, number] | null>(null);
  const [accuracy, setAccuracy] = useState(0);
  // 경로 계산에 쓰는 오차. 오차값은 제자리에서도 매번 바뀌므로, 경로가 깜빡이지 않게 위치를 갱신할 때만 같이 바꾼다.
  const [fixAccuracy, setFixAccuracy] = useState(0);
  const [status, setStatus] = useState<HereStatus>("finding");
  const last = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (!("geolocation" in navigator)) { setStatus("unsupported"); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const at: [number, number] = [p.coords.latitude, p.coords.longitude];
        const far = dist(at, CAMPUS_CENTER) > CAMPUS_RADIUS;
        setStatus(far ? "far" : "ok");
        setAccuracy(p.coords.accuracy);
        if (!last.current || dist(last.current, at) > 8) {
          last.current = at;
          setHere(at);
          setFixAccuracy(p.coords.accuracy);
        }
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unsupported"),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  return { here, accuracy, fixAccuracy, status };
}

const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));

const HERE_MESSAGE: Record<Exclude<HereStatus, "ok">, string> = {
  finding: "현재 위치를 찾는 중입니다",
  denied: "위치 권한이 꺼져 있어요 — 출발 건물을 골라주세요",
  far: "캠퍼스 밖에 계세요 — 출발 건물을 골라주세요",
  unsupported: "위치를 받을 수 없어요 — 출발 건물을 골라주세요",
};

/**
 * 첫 화면 '자주 가는 곳'. 강의실이 아니라 수업 사이에 들르는 곳 위주로 골랐다.
 * 네이버지도 '어디로 갈까요?'·카카오내비 고정 목적지 카드처럼 지금 위치에서 몇 분인지 같이 보여준다.
 * 이름은 건물 데이터에서 꺼낸다 — 카드와 눌렀을 때 시트 제목이 같은 이름이어야 한다.
 * 아이콘 색은 iOS 시스템 색.
 */
const QUICK = [
  { code: "L", Icon: BookOpen, color: "#af52de" },
  { code: "@학생회관", Icon: Users, color: "#007aff" },
  { code: "@교직원식당", Icon: Utensils, color: "#ff9500" },
  { code: "G", Icon: Dumbbell, color: "#34c759" },
  { code: "@대학본부", Icon: Landmark, color: "#8e8e93" },
] as const;

const NO_OPTS: RouteOptions = {};

/** 시트 높이 단계. 지도를 가리는 정도를 사용자가 고르게 한다. 가장 낮은 단계에서도 첫 화면 카드 한 줄은 보여야 한다. */
const SNAPS = [0.255, 0.52, 0.86] as const;

/**
 * 지도 핀에 넣을 짧은 글자.
 * 강의동은 코드가 한두 글자라 그대로 쓰지만(U, 9, ML),
 * 강의실 없는 건물은 코드가 '@교직원식당' 이라 이름을 줄여 쓴다.
 */
const pinLabel = (b: { code: string; name: string }) =>
  b.code.startsWith("@") ? b.name : b.code;

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const side = useSideLayout();
  const { ref, map, error } = useKakaoMap(CAMPUS_CENTER, 4);
  const [query, setQuery] = useState("");   // 애플지도처럼 빈 상태에서 시작
  const [fromCode, setFromCode] = useState(HERE);   // 기본은 현재 위치에서 출발
  // 경로 옵션(비 안 맞는 길·계단 없는 길)은 화면에서 뺐다. 근거 데이터가 부족해서 약속을 지킬 수 없었다
  // (실내 연결 데이터는 건물 관통 3곳뿐, 출입구 46개 중 계단 없음 확인은 1개). 엔진에는 남아 있다.
  const opts: RouteOptions = NO_OPTS;
  const [snap, setSnap] = useState(0);
  const { here, accuracy, fixAccuracy, status } = useHere();
  const fromHere = fromCode === HERE;

  const parsed = useMemo(() => parse(query), [query]);
  const toCode = parsed.ok ? parsed.code : null;
  const dest = toCode ? getBuilding(toCode) : null;

  const route: CampusRoute | HereRoute | null = useMemo(() => {
    if (!toCode) return null;
    if (fromHere) return here && status === "ok" ? routeFromHere(here, toCode, opts, fixAccuracy) : null;
    return toCode !== fromCode ? routeBetween(fromCode, toCode, opts) : null;
  }, [fromHere, here, fixAccuracy, status, fromCode, toCode, opts]);

  // 지름길을 탔으면 '안 탔을 때' 경로도 구한다. 둘을 나란히 보여주는 게 이 앱의 존재 이유다.
  const baseline: CampusRoute | null = useMemo(() => {
    if (!route || !toCode || !route.edges.some((e) => e.kind === "through_building")) return null;
    const o = { ...opts, noShortcut: true };
    const n = fromHere ? (here ? routeFromHere(here, toCode, o, fixAccuracy) : null) : routeBetween(fromCode, toCode, o);
    return n && n.seconds - route.seconds >= SHORTCUT_MIN_SAVED ? n : null;
  }, [route, toCode, opts, fromHere, here, fixAccuracy, fromCode]);
  const saved = route && baseline ? baseline.seconds - route.seconds : 0;

  // 현재 위치가 건물 안이면 그 건물에서 출발한 것으로 보여준다
  const startBuilding = fromHere ? (route as HereRoute | null)?.startBuilding ?? null : getBuilding(fromCode) ?? null;
  const originName = fromHere ? (startBuilding ? `현재 위치 (${startBuilding.name})` : "현재 위치") : startBuilding?.name ?? "";

  const steps = useMemo(
    () => (route && dest ? buildSteps(route, fromHere ? (startBuilding?.name ?? "현재 위치") : originName, dest.name) : []),
    [route, dest, fromHere, startBuilding, originName],
  );

  // 카카오 로고·축척 묶음에 이름표를 붙여 CSS 로 시트 위로 올린다 (index.css .kakao-copy).
  // SDK 가 지도를 그린 뒤에야 생기므로 잠깐 기다리며 찾는다.
  useEffect(() => {
    if (!map) return;
    let tries = 0;
    const id = setInterval(() => {
      const logo = document.querySelector<HTMLImageElement>('.map-tiles img[src*="m_bi"]');
      let el: HTMLElement | null = logo;
      while (el && el.style.position !== "absolute") el = el.parentElement;
      if (el) { el.classList.add("kakao-copy"); clearInterval(id); }
      else if (++tries > 40) clearInterval(id);
    }, 150);
    return () => clearInterval(id);
  }, [map]);

  // PC 는 화면이 넓어 기본 확대 수준이면 캠퍼스가 작다. 한 단계 확대하고,
  // 왼쪽 패널(400px) 절반만큼 비켜서 캠퍼스가 남은 지도의 가운데에 오게 한다.
  useEffect(() => {
    if (!map || !side) return;
    map.setLevel(3);
    map.setCenter(new window.kakao.maps.LatLng(CAMPUS_CENTER[0], CAMPUS_CENTER[1]));
    map.panBy(-200, 0);
  }, [map, side]);

  const pickDestination = useCallback((code: string) => {
    setQuery(getBuilding(code)?.name ?? code);
    setSnap((s) => Math.max(s, 1)); // 지도를 찍었으면 결과를 보여줘야 한다
  }, []);
  useMapOverlays(map, route, fromHere ? startBuilding?.code ?? null : fromCode, toCode, snap, pickDestination,
                 here, accuracy, fromHere, baseline, theme, side);

  const swap = () => {
    if (!toCode) return;
    if (fromHere) {
      // 현재 위치는 목적지가 될 수 없으니, 지금 있는 건물(또는 가장 가까운 건물)을 목적지로 넘긴다
      const nearHere = startBuilding ?? (here ? nearestBuilding(here, 80) : null);
      setFromCode(toCode);
      setQuery(nearHere?.name ?? "");
      return;
    }
    const prev = fromCode;
    setFromCode(toCode);
    setQuery(getBuilding(prev)?.name ?? prev);
  };

  // 현재 위치 버튼 — 출발지를 현재 위치로 되돌리고 지도를 내 자리로 옮긴다
  const locate = () => {
    setFromCode(HERE);
    if (map && here) map.panTo(new window.kakao.maps.LatLng(here[0], here[1]));
  };
  const locating = fromHere && status === "finding";

  // 첫 화면 카드 — 지금 출발지에서 각 장소까지 걸어서 몇 분. 위치를 아직 모르면 시간 없이 이름만.
  const quick = useMemo(() => {
    const at = fromHere && here && status === "ok" ? here : null;
    // 지금 있는 건물은 카드로 띄울 이유가 없다
    const hereCode = fromHere ? (at ? buildingAt(at, fixAccuracy)?.code : undefined) : fromCode;
    return QUICK.flatMap((q) => {
      const b = getBuilding(q.code);
      if (!b || q.code === hereCode) return [];
      const r = at ? routeFromHere(at, q.code, {}, fixAccuracy) : !fromHere ? routeBetween(fromCode, q.code) : null;
      return [{ ...q, name: b.name, seconds: r?.seconds ?? null, meters: r?.meters ?? null }];
    });
  }, [fromHere, here, fixAccuracy, status, fromCode]);

  const clearDest = () => { setQuery(""); setSnap(0); };
  const title = dest?.name ?? (query ? describe(parsed) : "어디로 갈까요?");
  const subtitle = dest
    ? [parsed.ok && parsed.floor !== null ? `${parsed.floor}층` : null, parsed.ok && parsed.room ? parsed.normalized : null]
        .filter(Boolean).join(" · ")
    : query ? ""
    : fromHere ? (status === "ok" ? "지금 위치에서 걸어서" : status === "finding" ? "현재 위치 찾는 중…" : "강의실 코드나 건물 이름을 입력하세요")
    : `${getBuilding(fromCode)?.name ?? ""}에서 걸어서`;

  const sheetBody = (
      <>
        {/* 제목 + 닫기 — 애플지도 시트 머리 */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[22px] leading-tight font-bold tracking-[-0.02em]">{title}</h2>
            {saved > 0 ? (
              // 시트를 내려둔 상태에서도 보이도록 제목 바로 밑에 한 줄
              <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[13px] font-semibold text-accent">
                <Zap className="size-3.5 fill-current" strokeWidth={0} /> 건물 통과 지름길 · {formatDuration(saved)} 단축
              </p>
            ) : subtitle && <p className="mt-0.5 text-[15px] text-muted-foreground">{subtitle}</p>}
          </div>
          {query && (
            <button onClick={clearDest} aria-label="목적지 지우기"
                    className="grid size-[30px] shrink-0 place-items-center rounded-full bg-muted text-muted-foreground active:scale-95">
              <X className="size-4" strokeWidth={2.6} />
            </button>
          )}
        </div>

        {route ? (
          <>
            <Summary seconds={route.seconds} meters={route.meters} />
            {baseline && (
              <ShortcutCard fast={route.seconds} slow={baseline.seconds}
                            via={crossedBuildings(route).map((c) => getBuilding(c)?.name ?? c)} />
            )}
            <Composition route={route} />
            <p className="mt-2 text-[13px] text-muted-foreground">
              {route.exitDoor ? (
                // 건물 안 어디에 있든 이 문이 목적지에 가장 빠르다
                <><span className="font-medium text-foreground">{originName}</span> ·{" "}
                  <span className="font-semibold text-primary">{route.exitDoor}</span>{ro(route.exitDoor)} 나가기</>
              ) : (
                <><span className="font-medium text-foreground">{originName}</span>에서 출발</>
              )}
              {fromHere && accuracy > 30 && <> · 위치 오차 약 {Math.round(accuracy)}m</>}
            </p>
          </>
        ) : query ? (
          <p className="mt-3 text-[15px] text-muted-foreground">
            {!parsed.ok ? "강의실 코드를 다시 확인해 주세요"
              : fromHere && status !== "ok" ? HERE_MESSAGE[status]
              : (fromHere ? startBuilding?.code : fromCode) === toCode ? "지금 그 건물에 계세요"
              : "경로를 계산할 수 없습니다"}
          </p>
        ) : (
          <QuickCards items={quick} onPick={(name) => { setQuery(name); setSnap(0); }} />
        )}

        {dest && <Roadview at={dest.center} label={dest.name} />}

        {steps.length > 0 && <StepList steps={steps} />}
      </>
  );

  return (
    <div className={`relative h-dvh overflow-hidden bg-background ${side ? "side-layout" : ""}`}>
      <div className="map-tiles absolute inset-0 bg-muted" ref={ref} />

      {error && (
        <div className="glass absolute inset-x-4 top-1/3 z-30 rounded-[22px] p-5">
          <p className="font-semibold">지도를 띄우지 못했습니다</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
      )}

      {/* 출발 · 도착 — 애플지도 경로 카드처럼 아이콘 원 + 가는 구분선 */}
      <div className={side ? "absolute top-4 bottom-4 left-4 z-20 flex w-[400px] flex-col gap-3"
                           : "absolute inset-x-2.5 top-[calc(env(safe-area-inset-top)+0.625rem)] z-20"}>
        <div className="glass flex items-center gap-1 rounded-[22px] py-1 pr-1.5 pl-3">
          <div className="min-w-0 flex-1">
            <Row icon={<span className="grid size-[26px] place-items-center rounded-full bg-primary text-white">
                         <Navigation className="size-3.5 fill-current" strokeWidth={0} /></span>}>
              <Select value={fromCode} onValueChange={(v) => v && setFromCode(v)}>
                <SelectTrigger
                  aria-label="출발 건물"
                  className="h-11 w-full border-0 bg-transparent px-0 text-[16px] font-medium shadow-none focus-visible:ring-0 dark:bg-transparent [&>svg]:hidden"
                >
                  <SelectValue>
                    {fromHere && status !== "ok" ? (status === "finding" ? "현재 위치 찾는 중…" : "현재 위치 (사용 불가)")
                                                 : originName || "건물 선택"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value={HERE}>
                    <Navigation className="size-3.5 fill-primary text-primary" strokeWidth={0} /> 현재 위치
                  </SelectItem>
                  {buildings.map((b) => (
                    <SelectItem key={b.code} value={b.code}>
                      {b.name} <span className="text-muted-foreground">{b.code.startsWith("@") ? "" : b.code}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <div className="ml-[38px] h-px bg-border" />
            <Row icon={<span className="grid size-[26px] place-items-center rounded-full bg-destructive text-white">
                         <MapPin className="size-3.5" strokeWidth={2.6} /></span>}>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="강의실 코드나 건물 (U524, 공학관)"
                aria-label="목적지 강의실"
                autoComplete="off"
                className="h-11 border-0 bg-transparent px-0 !text-[16px] font-medium shadow-none placeholder:text-muted-foreground placeholder:font-normal focus-visible:ring-0 dark:bg-transparent"
              />
            </Row>
          </div>
          <button onClick={swap} aria-label="출발지와 목적지 바꾸기"
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground/70 active:scale-95">
            <ArrowUpDown className="size-[17px]" strokeWidth={2.2} />
          </button>
        </div>

        {/* 지도 버튼 — 애플지도처럼 오른쪽 위 유리 원 */}
        <div className={side ? "fixed top-4 right-4" : "mt-2.5 flex justify-end"}>
          {/* 애플지도처럼 버튼 둘을 한 유리 캡슐에 세로로 묶는다 */}
          <div className="glass flex flex-col overflow-hidden rounded-full">
            <button
              onClick={locate} disabled={locating} aria-label="현재 위치에서 출발"
              className="grid size-11 place-items-center active:bg-muted"
            >
              <Navigation
                className={`size-[19px] ${fromHere && status === "ok" ? "fill-primary text-primary" : "text-primary"} ${locating ? "animate-pulse" : ""}`}
                strokeWidth={fromHere && status === "ok" ? 0 : 2.2}
              />
            </button>
            <div className="mx-2.5 h-px bg-border" />
            <button onClick={toggleTheme} aria-label={theme === "dark" ? "밝은 지도로" : "어두운 지도로"}
                    className="grid size-11 place-items-center text-foreground/75 active:bg-muted">
              {theme === "dark" ? <Sun className="size-[19px]" strokeWidth={2.2} /> : <Moon className="size-[18px]" strokeWidth={2.2} />}
            </button>
          </div>
        </div>
        {side && <Sheet side snap={snap} setSnap={setSnap}>{sheetBody}</Sheet>}
      </div>
      {side && (
        <a className="map-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
          경로 데이터 © OpenStreetMap 기여자
        </a>
      )}

      {!side && <Sheet snap={snap} setSnap={setSnap}>{sheetBody}</Sheet>}
    </div>
  );
}

/* ---------------- 바텀시트 ---------------- */

function Sheet({ snap, setSnap, children, side = false }: {
  snap: number; setSnap: (i: number) => void; children: React.ReactNode; side?: boolean;
}) {
  const drag = useRef<{ y: number; h: number; t: number } | null>(null);
  // 끌고 손을 떼면 브라우저가 click 도 보낸다. 그걸 '탭 = 한 단계 올리기' 로 받으면
  // 내려놓자마자 다시 올라간다. 끌었으면 그 click 은 버린다.
  const dragged = useRef(false);
  const [live, setLive] = useState<number | null>(null);
  const height = live ?? SNAPS[snap] * window.innerHeight;

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: SNAPS[snap] * window.innerHeight, t: performance.now() };
    dragged.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dy) > 6) dragged.current = true;   // 손 떨림은 탭으로 본다
    if (!dragged.current) return;
    setLive(Math.max(90, Math.min(window.innerHeight * 0.9, drag.current.h - dy)));
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current && dragged.current && live !== null) {
      const dy = e.clientY - drag.current.y;
      const v = dy / Math.max(1, performance.now() - drag.current.t);   // px/ms, 아래로 +
      let best: number;
      if (Math.abs(v) > 0.5) {
        // 휙 튕기면 거리와 상관없이 그 방향으로 한 단계
        best = Math.max(0, Math.min(SNAPS.length - 1, snap + (v > 0 ? -1 : 1)));
      } else {
        // 천천히 끌었으면 놓은 높이에서 가장 가까운 단계로
        const r = live / window.innerHeight;
        best = 0;
        SNAPS.forEach((s, i) => { if (Math.abs(s - r) < Math.abs(SNAPS[best] - r)) best = i; });
      }
      setSnap(best);
    }
    drag.current = null;
    setLive(null);
  };
  const onTap = () => {
    if (dragged.current) { dragged.current = false; return; }
    setSnap(snap === SNAPS.length - 1 ? 0 : snap + 1);
  };

  // 지도 출처 표기(카카오 로고·축척, OSM)는 시트 바로 위에 붙어 다닌다. 시트가 지도 아래쪽을 덮어서
  // 제자리(지도 맨 아래)에 두면 가려진다 — 카카오 약관은 로고를 가리지 못하게 하고, OSM 은 출처 표기가 의무다.
  // 시트를 끝까지 올리면 지도가 거의 안 보이니 숨긴다 (애플지도 'Legal' 과 같다).
  useLayoutEffect(() => {
    const st = document.documentElement.style;
    if (side) {   // 왼쪽 패널이면 지도 아래쪽을 덮지 않는다
      st.setProperty("--sheet-h", "0px"); st.setProperty("--credit-o", "1"); st.setProperty("--sheet-ease", "none");
      return;
    }
    st.setProperty("--sheet-h", `${height}px`);
    st.setProperty("--sheet-ease", live === null ? "bottom .34s cubic-bezier(.32,.72,0,1), opacity .2s" : "opacity .2s");
    st.setProperty("--credit-o", height > window.innerHeight * 0.7 ? "0" : "1");
  }, [height, live, side]);

  if (side) {
    // PC: 왼쪽 패널. 내용만큼 늘어나다가 화면 아래에 닿으면 안에서 스크롤한다. 끌어서 높이 바꾸기는 없다.
    return (
      <div className="glass-sheet flex min-h-0 flex-col overflow-hidden rounded-[28px]">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-5">{children}</div>
      </div>
    );
  }

  return (
    <>
    <a className="map-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
      경로 데이터 © OpenStreetMap 기여자
    </a>
    {/* 애플지도 iOS 26 시트 — 화면 가장자리에서 떨어져 떠 있고 네 모서리가 다 둥글다 */}
    <div
      className="glass-sheet absolute inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] z-20 flex flex-col overflow-hidden rounded-[32px]"
      style={{ height, transition: live === null ? "height .34s cubic-bezier(.32,.72,0,1)" : "none" }}
    >
      <div
        className="shrink-0 cursor-grab touch-none px-5 pt-2 pb-1.5 active:cursor-grabbing"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onClick={onTap}
        role="button" tabIndex={0} aria-label="시트 높이 조절"
      >
        <div className="mx-auto h-[5px] w-9 rounded-full bg-foreground/20" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1.5 pb-5">
        {children}
      </div>
    </div>
    </>
  );
}

/* ---------------- 첫 화면 카드 ---------------- */

type QuickItem = (typeof QUICK)[number] & { name: string; seconds: number | null; meters: number | null };

/**
 * 자주 가는 곳 — 가로로 넘기는 카드. 색 원 아이콘 + 이름 + 큰 숫자로 '몇 분'.
 * 위치를 모르면 숫자 자리에 거리 대신 '—' 를 둬서 카드 높이가 흔들리지 않게 한다.
 */
function QuickCards({ items, onPick }: { items: QuickItem[]; onPick: (name: string) => void }) {
  return (
    <div className="-mx-4 mt-3 flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((q) => (
        <button
          key={q.code} onClick={() => onPick(q.name)}
          className="flex w-[118px] shrink-0 flex-col items-start rounded-2xl bg-card p-3 text-left active:scale-[0.97]"
        >
          <span className="grid size-9 place-items-center rounded-full text-white" style={{ background: q.color }}>
            <q.Icon className="size-[18px]" strokeWidth={2.3} />
          </span>
          <span className="mt-2 w-full truncate text-[14px] font-semibold">{q.name}</span>
          <span className="num mt-0.5 text-[13px] text-muted-foreground">
            {q.seconds !== null
              ? <><b className="text-[17px] font-bold text-foreground">{Math.max(1, Math.round(q.seconds / 60))}</b>분 · {q.meters}m</>
              : "—"}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------------- 단계별 안내 ---------------- */

const STEP_ICON: Record<StepKind, React.ReactNode> = {
  start: <Navigation className="size-[18px] fill-current" strokeWidth={0} />,
  straight: <ArrowUp className="size-5" strokeWidth={2.4} />,
  left: <CornerUpLeft className="size-5" strokeWidth={2.4} />,
  right: <CornerUpRight className="size-5" strokeWidth={2.4} />,
  through: <Building2 className="size-5" strokeWidth={2.2} />,
  approach: <DoorOpen className="size-5" strokeWidth={2.2} />,
  arrive: <MapPin className="size-5" strokeWidth={2.4} />,
};

/** 애플 설정 앱·지도의 묶음 목록 — 연회색 위 흰 둥근 카드, 행 사이 가는 선(아이콘 오른쪽부터) */
function StepList({ steps }: { steps: Step[] }) {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 px-1 text-[13px] font-medium text-muted-foreground">경로 안내</h3>
      <ol className="overflow-hidden rounded-2xl bg-card">
        {steps.map((s, i) => {
          const tone = s.kind === "through" ? "text-accent"
            : s.kind === "start" ? "text-primary"
            : s.kind === "arrive" ? "text-destructive" : "text-foreground";
          return (
            <li key={i} className="flex items-center gap-3 pl-3.5">
              <span className={`grid size-8 shrink-0 place-items-center ${tone}`}>{STEP_ICON[s.kind]}</span>
              <div className={`min-w-0 flex-1 py-3 pr-4 ${i > 0 ? "border-t" : ""}`}>
                {s.meters > 0 && (
                  <p className="num text-[17px] leading-tight font-semibold">{s.meters}m</p>
                )}
                <p className={`text-[15px] leading-snug ${s.meters > 0 ? "text-muted-foreground" : "font-semibold"}`}>
                  {s.text}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ---------------- 작은 조각들 ---------------- */

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 애플지도 하단 막대 '9:54 도착 · 13분 · 10mi' — 큰 숫자 셋, 아래 작은 회색 라벨 */
function Summary({ seconds, meters }: { seconds: number; meters: number }) {
  const arrive = new Date(Date.now() + seconds * 1000);
  const hhmm = `${arrive.getHours()}:${String(arrive.getMinutes()).padStart(2, "0")}`;
  const min = Math.max(1, Math.round(seconds / 60));
  const cols = [
    { v: hhmm, l: "도착" },
    { v: `${min}분`, l: "소요", accent: true },
    { v: meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${meters}m`, l: "거리" },
  ];
  return (
    <div className="mt-3.5 grid grid-cols-3 rounded-2xl bg-card py-3">
      {cols.map((c, i) => (
        <div key={c.l} className={`text-center ${i > 0 ? "border-l" : ""}`}>
          <p className={`num text-[26px] leading-none font-bold ${c.accent ? "text-primary" : ""}`}>{c.v}</p>
          <p className="mt-1.5 text-[13px] text-muted-foreground">{c.l}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * 지름길 비교 — 같은 출발·도착을 건물 통과 없이 갔을 때와 막대로 나란히 놓는다.
 * 막대는 일반 길을 100% 로 두고 지름길이 얼마나 짧은지 길이로 보인다.
 */
function ShortcutCard({ fast, slow, via }: { fast: number; slow: number; via: string[] }) {
  const bars = [
    { label: "지름길", sec: fast, cls: "bg-accent", text: "text-accent" },
    { label: "일반 길", sec: slow, cls: "bg-muted-foreground/45", text: "text-muted-foreground" },
  ];
  return (
    <div className="mt-2.5 rounded-2xl bg-card p-3.5">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-white shadow-[0_4px_14px_rgb(255_149_0/0.45)]">
          <Zap className="size-5 fill-current" strokeWidth={0} />
        </span>
        <div className="min-w-0">
          <p className="text-[17px] leading-tight font-bold tracking-[-0.02em]">
            일반 길보다 <span className="num text-accent">{formatDuration(slow - fast)}</span> 빨라요
          </p>
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{via.join(" · ")} 안으로 통과</p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {bars.map((b, i) => (
          <div key={b.label} className="flex items-center gap-2.5">
            <span className={`w-12 shrink-0 text-[12.5px] font-semibold ${b.text}`}>{b.label}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className={`bar-grow h-full rounded-full ${b.cls}`}
                   style={{ width: `${(b.sec / slow) * 100}%`, animationDelay: `${120 + i * 120}ms` }} />
            </div>
            <span className="num w-[62px] shrink-0 text-right text-[13px] font-semibold">{formatDuration(b.sec)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 길 종류별 시간 — 애플지도 '🚶 2분' 같은 회색 캡슐 태그 */
function Composition({ route }: { route: CampusRoute }) {
  const parts = [
    { key: "through", label: "건물 관통", dot: "bg-accent" },
    { key: "path", label: "바깥 길", dot: "bg-primary" },
    { key: "approach", label: "건물 출입", dot: "bg-muted-foreground" },
  ] as const;
  const sec: Record<string, number> = { through: 0, path: 0, approach: 0 };
  for (const e of route.edges) {
    const k = e.kind === "through_building" ? "through" : e.kind === "approach" || e.kind === "indoor" ? "approach" : "path";
    sec[k] += e.seconds;
  }
  const shown = parts.filter((p) => sec[p.key] > 0);
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {shown.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12.5px] font-medium text-foreground/80">
          <i className={`size-2 rounded-full ${p.dot}`} />
          {p.label} {formatDuration(Math.round(sec[p.key]))}
        </span>
      ))}
      {route.hasUnverified && (
        <span className="inline-flex items-center rounded-full bg-accent/15 px-2.5 py-1 text-[12.5px] font-medium text-accent">
          미확인 구간 포함
        </span>
      )}
    </div>
  );
}

/* ---------------- 지도 오버레이 ---------------- */

/**
 * 건물 18개를 전부 라벨링하면 카카오 지도 자체 글자와 겹쳐 지저분해진다.
 * 출발지·목적지만 표시하고 나머지는 카카오 라벨에 맡긴다.
 */
function useMapOverlays(
  map: any, route: CampusRoute | null, fromCode: string | null, toCode: string | null,
  snap: number, onPick: (code: string) => void,
  here: [number, number] | null, accuracy: number, fromHere: boolean,
  baseline: CampusRoute | null, theme: Theme, side = false,
) {
  const drawn = useRef<any[]>([]);
  const raf = useRef<number | undefined>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;

  // 지도를 탭하면 그 자리의 건물이 목적지가 된다
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    const h = (e: any) => {
      const near = nearestBuilding([e.latLng.getLat(), e.latLng.getLng()], 70);
      if (near) pick.current(near.code);
    };
    kakao.maps.event.addListener(map, "click", h);
    return () => kakao.maps.event.removeListener(map, "click", h);
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    if (raf.current) cancelAnimationFrame(raf.current);
    drawn.current.forEach((o) => o.setMap(null));
    drawn.current = [];
    const add = (o: any) => { o.setMap(map); drawn.current.push(o); };

    const primary = token("--map-route");
    const destructive = token("--map-ink");

    // 캠퍼스 건물에 옅은 면을 깔아 형태를 만든다. 라벨은 안 붙인다 — 그게 지저분했다.
    for (const b of buildings) {
      if (b.polygon.length < 3 || b.code === fromCode || b.code === toCode) continue;
      add(new kakao.maps.Polygon({
        path: b.polygon.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
        strokeWeight: 1, strokeColor: token("--map-building-line"), strokeOpacity: 0.7,
        fillColor: token("--map-building"), fillOpacity: 0.55, zIndex: 2,
      }));
    }

    const shortcut = token("--map-shortcut");
    const dark = theme === "dark";
    const crossed = route ? crossedBuildings(route) : [];

    // 지름길로 통과하는 건물은 주황으로 칠한다 — '여기를 뚫고 간다' 가 한눈에 보이게
    for (const code of crossed) {
      const b = getBuilding(code);
      if (!b || b.polygon.length < 3 || code === toCode) continue;
      add(new kakao.maps.Polygon({
        path: b.polygon.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
        strokeWeight: 2, strokeColor: shortcut, strokeOpacity: 0.95,
        fillColor: shortcut, fillOpacity: dark ? 0.3 : 0.22, zIndex: 3,
      }));
    }

    // 지름길을 안 탔을 때의 길 — 회색 점선으로 밑에 깐다. 둘의 차이가 이 앱이 하는 일이다.
    if (baseline) {
      add(new kakao.maps.Polyline({
        path: baseline.path.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
        strokeWeight: 5, strokeColor: token("--map-baseline"), strokeOpacity: 0.95,
        strokeStyle: "shortdash", zIndex: 4,
      }));
    }

    for (const [code, color] of [[fromCode, primary], [toCode, destructive]] as const) {
      const b = code ? getBuilding(code) : null;
      if (b && b.polygon.length >= 3) {
        add(new kakao.maps.Polygon({
          path: b.polygon.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
          strokeWeight: 1.5, strokeColor: color, strokeOpacity: 0.8,
          fillColor: color, fillOpacity: 0.1,
        }));
      }
    }

    if (route) {
      // 경로를 출발지에서 도착지로 그려 나간다. 한 번에 뿅 나타나는 것보다
      // 어디서 어디로 가는지가 몸에 들어온다.
      const colored: { line: any; pts: any[] }[] = [];
      for (const s of route.segments) {
        const through = s.kind === "through_building";
        const approach = s.kind === "approach";
        const pts = s.points.map(([la, lo]) => new kakao.maps.LatLng(la, lo));
        // 밤 지도에선 넓고 옅은 선을 한 겹 더 깔아 경로가 빛나 보이게 한다
        if (dark && !approach) {
          add(new kakao.maps.Polyline({
            path: pts, strokeWeight: through ? 24 : 20,
            strokeColor: through ? shortcut : primary, strokeOpacity: through ? 0.32 : 0.26, zIndex: 5,
          }));
        }
        // 애플지도 경로 — 굵은 파란 선에 한 톤 짙은 테두리. 건물 출입 구간만 회색 점선.
        if (!approach) {
          add(new kakao.maps.Polyline({
            path: pts, strokeWeight: through ? 12 : 10,
            strokeColor: through ? token("--map-shortcut-edge") : token("--map-route-edge"),
            strokeOpacity: 1, strokeStyle: "solid", zIndex: 6,
          }));
        }
        const line = new kakao.maps.Polyline({
          path: [], strokeWeight: approach ? 4 : through ? 8 : 7,
          strokeColor: token(through ? "--map-shortcut" : approach ? "--map-label" : "--map-route"),
          strokeOpacity: approach ? 0.85 : 1,
          strokeStyle: approach ? "shortdot" : "solid", zIndex: 7,
        });
        add(line);
        colored.push({ line, pts });
      }

      const total = colored.reduce((n, c) => n + c.pts.length, 0);

      const DRAW = 650;       // 그려지는 시간
      const t0 = performance.now();

      const tick = (now: number) => {
        const elapsed = now - t0;

        // 출발지에서 도착지로 선이 뻗어 나간다
        const p = Math.min(1, elapsed / DRAW);
        const eased = 1 - Math.pow(1 - p, 3);
        let budget = Math.ceil(eased * total);
        for (const c of colored) {
          const take = Math.max(0, Math.min(c.pts.length, budget));
          c.line.setPath(take >= 2 ? c.pts.slice(0, take) : []);
          budget -= c.pts.length;
        }

        if (p < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);

      // 지도 위 말풍선 둘 — 관통 지점엔 '몇 분 단축', 일반 길에서 가장 멀리 벌어진 곳엔 '일반 길 몇 분'.
      // 선이 다 그려진 뒤에 튀어나오게 CSS 지연을 준다.
      if (baseline) {
        const mid = route.segments.find((s) => s.kind === "through_building");
        if (mid) {
          const at = mid.points[Math.floor(mid.points.length / 2)];
          add(new kakao.maps.CustomOverlay({
            position: new kakao.maps.LatLng(at[0], at[1]), yAnchor: 1.35, zIndex: 9,
            content: `<div class="map-badge map-badge-shortcut"><b>⚡</b>${formatDuration(baseline.seconds - route.seconds)} 단축</div>`,
          }));
        }
        // 양 끝은 출발점·목적지 핀에 가려지니, 일반 길의 가운데 구간(30~70%)에서만 고른다
        const bp = baseline.path;
        const acc = [0];
        for (let i = 1; i < bp.length; i++) acc.push(acc[i - 1] + dist(bp[i - 1], bp[i]));
        const L = acc[acc.length - 1] || 1;
        let far = bp[0], farD = -1;
        for (let i = 0; i < bp.length; i++) {
          const q = bp[i];
          if (acc[i] / L < 0.3 || acc[i] / L > 0.7) continue;
          const d = Math.min(...route.path.map((r) => dist(q, r)));
          if (d > farD) { farD = d; far = q; }
        }
        if (farD > 25) {
          add(new kakao.maps.CustomOverlay({
            position: new kakao.maps.LatLng(far[0], far[1]), yAnchor: 0.5, zIndex: 8,
            content: `<div class="map-badge map-badge-base">일반 길 ${Math.max(1, Math.round(baseline.seconds / 60))}분</div>`,
          }));
        }
      }
    }

    // 내 위치 — 지도 앱들처럼 파란 점과 오차 범위 원. 출발지를 현재 위치로 쓸 때만 그린다.
    if (here && fromHere) {
      if (accuracy > 8 && accuracy < 200) {
        add(new kakao.maps.Circle({
          center: new kakao.maps.LatLng(here[0], here[1]), radius: accuracy,
          strokeWeight: 1, strokeColor: "#2563eb", strokeOpacity: 0.35,
          fillColor: "#2563eb", fillOpacity: 0.1, zIndex: 2,
        }));
      }
      add(new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(here[0], here[1]),
        content: '<div class="me-dot"></div>', yAnchor: 0.5, zIndex: 6,
      }));
    }

    const from = fromCode && !(fromHere && !route) ? getBuilding(fromCode) : null;
    if (from && !(fromHere && here)) {
      add(new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(from.center[0], from.center[1]),
        content: `<div class="marker-dot" style="--c:${primary}"></div>`,
        yAnchor: 0.5, zIndex: 3,
      }));
    }
    const to = toCode ? getBuilding(toCode) : null;
    if (to) {
      add(new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(to.center[0], to.center[1]),
        content: `<div class="marker-pin" style="--c:${destructive}"><span>${pinLabel(to)}</span></div>`,
        yAnchor: 1, zIndex: 4,
      }));
    }

    if (route) {
      const bounds = new kakao.maps.LatLngBounds();
      // 건물 안에서 출발하면 경로는 문에서 시작한다. 내 위치 점이 화면 밖으로 잘리지 않게 같이 넣는다.
      [...route.path, ...(baseline?.path ?? []), ...(here && fromHere ? [here] : [])]
        .forEach(([la, lo]) => bounds.extend(new kakao.maps.LatLng(la, lo)));
      // 위는 검색 카드, 아래는 시트가 가린다. 시트 높이만큼 여백을 주되
      // 화면의 45% 를 넘기지 않는다 — 넘기면 보일 자리가 없어 지도가 통째로 줌아웃된다.
      const h = window.innerHeight;
      const bottom = Math.min(Math.round(h * SNAPS[snap]) + 24, Math.round(h * 0.45));
      if (side) map.setBounds(bounds, 60, 90, 60, 460);   // 왼쪽 패널(400px)만큼 비운다
      else map.setBounds(bounds, 150, 56, bottom, 56);
    }
  }, [map, route, fromCode, toCode, snap, here, accuracy, fromHere, baseline, theme, side]);
}
