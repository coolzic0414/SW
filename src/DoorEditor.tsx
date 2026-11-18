/**
 * 출입구 조사 도구 — /?edit
 *
 * 실제 문 위치는 어디에도 공개돼 있지 않다. OSM 에 entrance 태그가 0 개고,
 * 도로명주소 좌표는 건물 안쪽을 가리키고, 카카오도 출입구는 주지 않는다.
 * 결국 두 가지 방법뿐이다 — 스카이뷰·로드뷰로 읽거나, 아는 사람이 찍거나.
 * 이 도구는 둘을 한 화면에 올려서 학교에 안 가도 찍을 수 있게 한다.
 *
 * 쓰는 법
 *   1) 담당 번호를 고르면 28개 건물이 4명에게 나뉜다
 *   2) 건물을 고르면 지도가 그 건물로 확대된다 (스카이뷰가 기본)
 *   3) 문이 있는 자리를 누르면 아래 로드뷰가 그쪽을 바라본다 — 눈으로 확인하고 저장
 *   4) 다 찍으면 doors.json 을 받아서 한 명에게 모아 tools/merge_doors.py 로 합친다
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Trash2, Download, Undo2, DoorOpen, Check, X, Satellite, Map as MapIcon, Camera, Route,
} from "lucide-react";
import { useKakaoMap } from "./useKakaoMap.ts";
import { buildings, getBuilding } from "./lib/campus.ts";
import { Button } from "@/components/ui/button";

const CAMPUS_CENTER: [number, number] = [36.77004, 126.93192];

/** 조사 인원. 건물을 번갈아 나눠 갖는다 — 캠퍼스 한쪽에 몰리지 않게. */
const SURVEYORS = 4;

export interface Door {
  code: string;
  at: [number, number];
  label?: string;
  accessible?: boolean;
  /** 어떻게 확인했는가. 로드뷰로 눈으로 본 문과 기억으로 찍은 문을 구분한다. */
  via?: "roadview" | "knowledge";
}

const LABELS = ["정문", "후문", "측문", "지하", "연결통로"];

/** 길 그리기에서 고르는 길 종류. extract_paths.py 의 WALKABLE 과 같은 이름을 쓴다. */
const KINDS = [
  { id: "footway", label: "평지 길" },
  { id: "steps", label: "계단" },
  { id: "path", label: "흙길·오르막" },
  { id: "escalator", label: "에스컬레이터" },
] as const;

interface DrawnPath {
  name: string;
  kind: string;
  points: [number, number][];
  accessible?: boolean;
  /** 비탈이면 어느 끝이 아래인가. 고도 데이터가 없어서 사람이 적어야 한다. */
  lower_end?: "start" | "end";
}

export default function DoorEditor() {
  const { ref, map, error } = useKakaoMap(CAMPUS_CENTER, 3);

  const [who, setWho] = useState<number>(() => Number(localStorage.getItem("doorWho") ?? 0));
  const [doors, setDoors] = useState<Door[]>(() => {
    try { return JSON.parse(localStorage.getItem("doors") ?? "[]"); } catch { return []; }
  });
  const [picked, setPicked] = useState<string | null>(null);   // 지금 찍는 건물
  const [pending, setPending] = useState<[number, number] | null>(null); // 저장 대기 지점
  const [label, setLabel] = useState(LABELS[0]);
  const [accessible, setAccessible] = useState(false);
  const [sky, setSky] = useState(true);

  // 문 찍기 / 길 그리기
  const [mode, setMode] = useState<"door" | "path">("door");
  const [paths, setPaths] = useState<DrawnPath[]>(() => {
    try { return JSON.parse(localStorage.getItem("paths") ?? "[]"); } catch { return []; }
  });
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [kind, setKind] = useState<string>(KINDS[0].id);
  const [lowerEnd, setLowerEnd] = useState<"" | "start" | "end">("");
  useEffect(() => { localStorage.setItem("paths", JSON.stringify(paths)); }, [paths]);

  useEffect(() => { localStorage.setItem("doors", JSON.stringify(doors)); }, [doors]);
  useEffect(() => { localStorage.setItem("doorWho", String(who)); }, [who]);

  // 내 담당 건물. 번호를 번갈아 나눠서 한 사람이 캠퍼스 한구석만 맡지 않게 한다.
  const mine = useMemo(
    () => buildings.filter((_, i) => who === SURVEYORS || i % SURVEYORS === who),
    [who],
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of doors) m.set(d.code, (m.get(d.code) ?? 0) + 1);
    return m;
  }, [doors]);
  const target = picked ? getBuilding(picked) : null;

  // 담당이 바뀌면 첫 건물로
  useEffect(() => { setPicked(mine[0]?.code ?? null); }, [who]);

  // 건물을 고르면 지도를 그 건물로 끌어다 확대한다
  useEffect(() => {
    if (!map || !target) return;
    const { kakao } = window;
    map.setCenter(new kakao.maps.LatLng(target.center[0], target.center[1]));
    map.setLevel(1);
    setPending(null);
  }, [map, picked]);

  // 스카이뷰 ↔ 일반지도. 문은 스카이뷰가 아니면 보이지 않는다.
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    map.setMapTypeId(sky ? kakao.maps.MapTypeId.SKYVIEW : kakao.maps.MapTypeId.ROADMAP);
  }, [map, sky]);

  // 지도를 누르면 바로 저장하지 않고 '대기'로 둔다 — 로드뷰로 확인한 뒤 저장
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    const h = (e: { latLng: { getLat(): number; getLng(): number } }) => {
      const at: [number, number] = [e.latLng.getLat(), e.latLng.getLng()];
      if (liveMode.current === "path") setDraft((d) => [...d, at]);
      else setPending(at);
    };
    kakao.maps.event.addListener(map, "click", h);
    return () => kakao.maps.event.removeListener(map, "click", h);
  }, [map]);

  // 이벤트 핸들러는 지도에 한 번만 붙으므로, 바뀌는 모드는 ref 로 읽는다
  const liveMode = useRef(mode);
  liveMode.current = mode;

  const finishPath = () => {
    if (draft.length < 2) return;
    const from = target?.name ?? "어딘가";
    setPaths((p) => [...p, {
      name: `${from} 옆 ${KINDS.find((k) => k.id === kind)!.label} ${p.length + 1}`,
      kind,
      points: draft,
      ...(kind === "footway" || kind === "escalator" ? { accessible: true } : {}),
      ...(lowerEnd ? { lower_end: lowerEnd } : {}),
    }]);
    setDraft([]);
  };

  const commit = () => {
    if (!pending || !picked) return;
    setDoors((d) => [...d, { code: picked, at: pending, label, accessible, via: "roadview" }]);
    setPending(null);
  };

  // 건물 외곽 · 찍은 문 · 대기 지점 그리기
  const drawn = useRef<unknown[]>([]);
  useEffect(() => {
    if (!map) return;
    const { kakao } = window;
    (drawn.current as { setMap(m: unknown): void }[]).forEach((o) => o.setMap(null));
    drawn.current = [];
    const add = (o: { setMap(m: unknown): void }) => { o.setMap(map); drawn.current.push(o); };

    for (const b of buildings) {
      if (b.polygon.length < 3) continue;
      const isTarget = b.code === picked;
      // 찍는 건물만 또렷하게. 나머지는 위치 참고용으로만 깔아둔다.
      add(new kakao.maps.Polygon({
        path: b.polygon.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
        strokeWeight: isTarget ? 3 : 1,
        strokeColor: isTarget ? "#f97316" : "#ffffff",
        strokeOpacity: isTarget ? 1 : 0.45,
        fillColor: "#f97316", fillOpacity: isTarget ? 0.12 : 0,
      }));
    }
    if (target) {
      add(new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(target.center[0], target.center[1]),
        content: `<div class="edit-tag">${target.name}</div>`,
        yAnchor: 0.5, zIndex: 3,
      }));
    }

    doors.forEach((d, i) => {
      if (d.code !== picked) return;
      add(new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(d.at[0], d.at[1]),
        content: `<div class="door-mark${d.accessible ? " door-acc" : ""}"><span>${i + 1}</span></div>`,
        yAnchor: 0.5, zIndex: 5,
      }));
    });

    // 저장해 둔 길과 지금 그리는 선
    const KIND_COLOR: Record<string, string> = {
      footway: "#22c55e", steps: "#ef4444", path: "#a16207", escalator: "#a855f7",
    };
    for (const pa of paths) {
      add(new kakao.maps.Polyline({
        path: pa.points.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
        strokeWeight: 5, strokeColor: KIND_COLOR[pa.kind] ?? "#22c55e", strokeOpacity: 0.9,
      }));
    }
    if (draft.length) {
      add(new kakao.maps.Polyline({
        path: draft.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
        strokeWeight: 5, strokeColor: "#f97316", strokeOpacity: 1, strokeStyle: "shortdash",
      }));
      draft.forEach((d, i) => add(new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(d[0], d[1]),
        content: `<div class="door-mark">${i + 1}</div>`, yAnchor: 0.5, zIndex: 6,
      })));
    }

    if (pending) {
      add(new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(pending[0], pending[1]),
        content: `<div class="door-pending"></div>`,
        yAnchor: 0.5, zIndex: 6,
      }));
    }
  }, [map, doors, picked, pending, paths, draft]);

  const download = () => {
    const payload = {
      _note: "재학생이 스카이뷰·로드뷰를 보며 직접 찍은 출입구. tools/extract_paths.py 가 읽는다.",
      _surveyor: who === SURVEYORS ? "전체" : `${who + 1}/${SURVEYORS}`,
      _surveyed_at: new Date().toISOString().slice(0, 10),
      paths,   // 길 그리기로 넣은 것. data/paths-manual.json 에 붙인다.
      doors: doors.map((d) => ({
        code: d.code,
        at: [Number(d.at[0].toFixed(7)), Number(d.at[1].toFixed(7))],
        label: d.label ?? "정문",
        accessible: d.accessible ?? false,
        via: d.via ?? "knowledge",
      })),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `doors-${who === SURVEYORS ? "all" : who + 1}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const left = mine.filter((b) => !counts.has(b.code)).length;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* 지도 */}
      <div className="relative min-h-0 flex-1">
        <div className={`absolute inset-0 bg-muted ${sky ? "" : "map-tiles"}`} ref={ref} />
        {error && (
          <div className="absolute inset-x-4 top-1/3 z-30 rounded-xl border bg-card p-5 shadow-xl">
            <p className="font-semibold">지도를 띄우지 못했습니다</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
        )}

        {/* 담당 · 건물 고르기 */}
        <div className="absolute inset-x-2 top-2 z-20 rounded-2xl border bg-card/95 p-2.5 shadow-lg backdrop-blur">
          <div className="flex items-center gap-2">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold">
              <DoorOpen className="size-4" /> 출입구 조사
            </p>
            <div className="ml-auto flex gap-1">
              {[...Array(SURVEYORS).keys(), SURVEYORS].map((n) => (
                <button
                  key={n} onClick={() => setWho(n)}
                  className={`size-6 rounded-full border text-[11px] font-semibold ${
                    who === n ? "border-primary bg-primary text-primary-foreground"
                              : "text-muted-foreground"}`}
                  aria-label={n === SURVEYORS ? "전체 보기" : `${n + 1}번 담당`}
                >
                  {n === SURVEYORS ? "전" : n + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="-mx-0.5 mt-2 flex gap-1 overflow-x-auto pb-0.5">
            {mine.map((b) => {
              const n = counts.get(b.code) ?? 0;
              return (
                <button
                  key={b.code} onClick={() => setPicked(b.code)}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] whitespace-nowrap ${
                    picked === b.code ? "border-primary bg-primary/10 font-semibold text-primary"
                      : n ? "text-muted-foreground" : "border-accent/50 text-accent"}`}
                >
                  {b.name.replace("순천향대학교 ", "")}
                  {n > 0 && <b className="ml-1 tabular-nums">{n}</b>}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            {left > 0
              ? <>남은 건물 <b className="text-accent">{left}</b>곳 · 주황색이 아직 안 찍은 건물</>
              : <>담당 {mine.length}곳 모두 찍었습니다. doors.json 을 받아 공유해주세요.</>}
          </p>
        </div>

        <div className="absolute top-2 right-2 z-20 mt-[82px] flex flex-col gap-1.5">
          <button
            onClick={() => { setMode((m) => (m === "door" ? "path" : "door")); setPending(null); setDraft([]); }}
            className={`grid size-10 place-items-center rounded-xl border shadow-lg backdrop-blur ${
              mode === "path" ? "border-primary bg-primary text-primary-foreground" : "bg-card/95"}`}
            aria-label={mode === "door" ? "길 그리기로" : "문 찍기로"}
          >
            {mode === "door" ? <Route className="size-4" /> : <DoorOpen className="size-4" />}
          </button>
        </div>
        <button
          onClick={() => setSky((v) => !v)}
          className="absolute top-2 right-2 z-20 mt-[134px] grid size-10 place-items-center rounded-xl border bg-card/95 shadow-lg backdrop-blur"
          aria-label={sky ? "일반지도로" : "스카이뷰로"}
        >
          {sky ? <MapIcon className="size-4" /> : <Satellite className="size-4" />}
        </button>
      </div>

      {/* 로드뷰 — 찍은 자리를 눈으로 확인한다 */}
      <DoorRoadview at={pending} />

      {/* 조작 */}
      <div className="shrink-0 border-t bg-card px-4 pt-2.5 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
        {mode === "path" ? (
          <>
            <p className="text-[12.5px] text-muted-foreground">
              길을 따라 <b className="text-foreground">꺾이는 자리마다</b> 누르세요. 2점 이상이면 저장됩니다.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.id} onClick={() => setKind(k.id)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    kind === k.id ? "border-primary bg-primary/10 font-semibold text-primary"
                                  : "text-muted-foreground"}`}
                >{k.label}</button>
              ))}
            </div>
            {/* 고도 데이터가 없어서, 비탈은 사람이 '어느 쪽이 아래인지' 알려줘야 한다 */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">비탈이면 아래쪽은</span>
              {([["", "평지"], ["start", "처음 찍은 쪽"], ["end", "마지막 찍은 쪽"]] as const).map(
                ([v, t]) => (
                  <button
                    key={v} onClick={() => setLowerEnd(v)}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      lowerEnd === v ? "border-primary bg-primary/10 font-semibold text-primary"
                                     : "text-muted-foreground"}`}
                  >{t}</button>
                ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm">
                <b className="tabular-nums">{draft.length}</b>
                <span className="text-muted-foreground">점 · 길 {paths.length}개</span>
              </span>
              <Button size="sm" className="ml-auto" onClick={finishPath} disabled={draft.length < 2}>
                <Check className="size-4" /> 이 길 저장
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDraft((d) => d.slice(0, -1))}
                      disabled={!draft.length}>
                <Undo2 className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft([]); setPaths([]); }}
                      disabled={!draft.length && !paths.length} className="text-muted-foreground">
                <Trash2 className="size-4" />
              </Button>
            </div>
          </>
        ) : pending ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {LABELS.map((l) => (
                <button
                  key={l} onClick={() => setLabel(l)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    label === l ? "border-primary bg-primary/10 font-semibold text-primary"
                                : "text-muted-foreground"}`}
                >{l}</button>
              ))}
              <button
                onClick={() => setAccessible((v) => !v)}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  accessible ? "border-primary bg-primary/10 font-semibold text-primary"
                             : "text-muted-foreground"}`}
              >계단 없음</button>
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="flex-1" onClick={commit}>
                <Check className="size-4" /> {target?.name} {label} 저장
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPending(null)}>
                <X className="size-4" /> 취소
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[12.5px] text-muted-foreground">
              스카이뷰에서 <b className="text-foreground">캐노피·보도블럭이 벽에 닿는 자리</b>를
              누르세요. 로드뷰로 확인한 뒤 저장합니다.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm">
                <b className="tabular-nums">{doors.length}</b>
                <span className="text-muted-foreground"> 개 찍음</span>
              </span>
              <Button size="sm" className="ml-auto" onClick={download} disabled={!doors.length}>
                <Download className="size-4" /> 내려받기
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDoors((d) => d.slice(0, -1))}
                      disabled={!doors.length}>
                <Undo2 className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDoors([])} disabled={!doors.length}
                      className="text-muted-foreground">
                <Trash2 className="size-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 누른 자리를 바라보는 로드뷰.
 * 로드뷰는 캠퍼스 도로까지만 들어오니 반경을 넉넉히(120m) 잡고, 못 찾으면 조용히 접는다.
 */
function DoorRoadview({ at }: { at: [number, number] | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "none">("idle");

  useEffect(() => {
    const { kakao } = window;
    if (!at || !box.current || !kakao?.maps?.Roadview) return;
    setState("loading");
    const pos = new kakao.maps.LatLng(at[0], at[1]);
    const view = new kakao.maps.Roadview(box.current);
    let settled = false;
    const giveUp = setTimeout(() => { if (!settled) setState("none"); }, 6000);

    new kakao.maps.RoadviewClient().getNearestPanoId(pos, 120, (panoId: number | null) => {
      settled = true;
      clearTimeout(giveUp);
      if (!panoId) return setState("none");
      view.setPanoId(panoId, pos);
      setState("ok");
      kakao.maps.event.addListener(view, "init", () => {
        const from = view.getPosition();
        const dy = at[0] - from.getLat();
        const dx = (at[1] - from.getLng()) * Math.cos((at[0] * Math.PI) / 180);
        view.setViewpoint({ pan: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360, tilt: 0, zoom: 1 });
      });
    });
    return () => clearTimeout(giveUp);
  }, [at?.[0], at?.[1]]);

  if (!at) return null;

  return (
    <div className="relative h-[30dvh] shrink-0 border-t bg-muted">
      <div ref={box} className="h-full w-full" />
      {state !== "ok" && (
        <div className="absolute inset-0 grid place-content-center justify-items-center gap-1">
          <Camera className="size-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {state === "loading" ? "로드뷰 불러오는 중" : "이 자리는 로드뷰가 없습니다 — 스카이뷰로 판단하세요"}
          </p>
        </div>
      )}
    </div>
  );
}
