/**
 * MapLibre 버전 — 지도 자체를 우리가 디자인한다.
 *
 * 카카오 버전과 다른 점은 지도 레이어뿐이다. 경로 계산·단계 안내·강의실 코드 해석은
 * 같은 모듈을 그대로 쓴다. 지도를 바꿔도 앱의 알맹이는 안 흔들린다는 뜻이다.
 *
 * 타일: OpenFreeMap (무료, API 키 없음) · 렌더러: MapLibre GL JS (BSD)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 는 타일 파싱을 웹 워커에서 한다. 번들러가 워커 URL 을 못 찾으면
// "Worker failed to load" 로 지도가 통째로 비어버리므로 Vite 에 직접 알려준다.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import {
  ArrowUpDown, CloudRain, Accessibility, Split, Search, LocateFixed,
} from "lucide-react";
import {
  buildings, parse, describe, getBuilding, routeBetween, formatDuration, nearestBuilding,
  type CampusRoute,
} from "./lib/campus.ts";
import { buildSteps } from "./lib/steps.ts";
import type { RouteOptions } from "./lib/graph.ts";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Sheet, StepList, Composition, SNAPS } from "./ui/RouteSheet.tsx";

maplibregl.setWorkerUrl(workerUrl);

const CAMPUS: [number, number] = [126.93192, 36.77004]; // MapLibre 는 [경도, 위도]
const STYLE = "https://tiles.openfreemap.org/styles/positron";

/**
 * CSS 토큰을 MapLibre 가 읽을 수 있는 색으로 바꾼다.
 * 우리 테마는 oklch 인데 MapLibre 파서는 그걸 모른다. 브라우저에 한 번 계산시켜
 * rgb() 로 받아온다.
 */
/** 지도용 hex 토큰을 읽는다 (index.css 의 --map-* 참고). */
const token = (n: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#16a34a";

function useSystemTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.classList.toggle("dark", mq.matches);
      setDark(mq.matches);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return dark;
}

export default function AppGL() {
  const dark = useSystemTheme();
  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MLMap | null>(null);
  const [query, setQuery] = useState("U524");
  const [fromCode, setFromCode] = useState("9");
  const [opts, setOpts] = useState<RouteOptions>({});
  const [snap, setSnap] = useState(0);
  const [locating, setLocating] = useState(false);

  const parsed = useMemo(() => parse(query), [query]);
  const toCode = parsed.ok ? parsed.code : null;
  const dest = toCode ? getBuilding(toCode) : null;
  const origin = getBuilding(fromCode);

  const route: CampusRoute | null = useMemo(
    () => (toCode && fromCode && toCode !== fromCode ? routeBetween(fromCode, toCode, opts) : null),
    [fromCode, toCode, opts],
  );
  const steps = useMemo(
    () => (route && origin && dest ? buildSteps(route, origin.name, dest.name) : []),
    [route, origin, dest],
  );

  /* ---------- 지도 만들기 ---------- */
  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({
      container: box.current,
      style: STYLE,
      center: CAMPUS,
      zoom: 16.2,
      pitch: 52,        // 기울여야 건물이 선다
      bearing: -17,
      attributionControl: { compact: true },
    });
    m.on("load", () => { m.resize(); setMap(m); });
    // 컨테이너가 나중에 크기를 잡는 경우가 있다. 안 맞추면 캔버스가 기본값(800×600)에
    // 머물러 지도가 비어 보인다.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(box.current);
    return () => { ro.disconnect(); m.remove(); };
  }, []);

  /* ---------- 캠퍼스 건물을 3D 로 세운다 ---------- */
  useEffect(() => {
    if (!map) return;
    const fc = {
      type: "FeatureCollection" as const,
      features: buildings
        .filter((b) => b.polygon.length >= 3)
        .map((b) => ({
          type: "Feature" as const,
          properties: { code: b.code, name: b.name },
          geometry: {
            type: "Polygon" as const,
            // GeoJSON 은 [경도, 위도] 순서다
            coordinates: [[...b.polygon.map(([la, lo]) => [lo, la]), [b.polygon[0][1], b.polygon[0][0]]]],
          },
        })),
    };

    if (!map.getSource("campus")) {
      map.addSource("campus", { type: "geojson", data: fc });
      map.addLayer({
        id: "campus-3d",
        type: "fill-extrusion",
        source: "campus",
        paint: {
          "fill-extrusion-height": 18,
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.92,
          "fill-extrusion-color": "#d9dbde",
        },
      });
      map.addLayer({
        id: "campus-label",
        type: "symbol",
        source: "campus",
        layout: {
          "text-field": ["get", "code"],
          "text-size": 11,
          "text-font": ["Noto Sans Regular"],
          "text-allow-overlap": false,
        },
        paint: { "text-color": "#8b8f96", "text-halo-color": "#ffffff", "text-halo-width": 1.2 },
      });
    }
  }, [map]);

  /* ---------- 선택된 건물 강조 ---------- */
  useEffect(() => {
    if (!map || !map.getLayer("campus-3d")) return;
    map.setPaintProperty("campus-3d", "fill-extrusion-color", [
      "case",
      ["==", ["get", "code"], toCode ?? "__"], token("--map-ink"),
      ["==", ["get", "code"], fromCode], token("--map-route"),
      token("--map-building"),
    ]);
    map.setPaintProperty("campus-3d", "fill-extrusion-height", [
      "case",
      ["any", ["==", ["get", "code"], toCode ?? "__"], ["==", ["get", "code"], fromCode]], 30,
      18,
    ]);
    map.setPaintProperty("campus-label", "text-color", token("--map-label"));
    map.setPaintProperty("campus-label", "text-halo-color", token("--map-halo"));
  }, [map, toCode, fromCode, dark]);

  /* ---------- 다크모드: 스타일 레이어 색을 눌러준다 ---------- */
  useEffect(() => {
    if (!map) return;
    for (const layer of map.getStyle().layers ?? []) {
      const id = layer.id;
      try {
        if (layer.type === "background") map.setPaintProperty(id, "background-color", token("--map-bg"));
        else if (layer.type === "fill") map.setPaintProperty(id, "fill-color", token("--map-surface"));
        else if (layer.type === "line") map.setPaintProperty(id, "line-color", token("--map-line"));
        else if (layer.type === "symbol") {
          map.setPaintProperty(id, "text-color", token("--map-label"));
          map.setPaintProperty(id, "text-halo-color", token("--map-halo"));
        }
      } catch { /* 해당 속성이 없는 레이어는 건너뛴다 */ }
    }
  }, [map, dark]);

  /* ---------- 경로 ---------- */
  useEffect(() => {
    if (!map) return;
    const empty = { type: "FeatureCollection" as const, features: [] as any[] };

    if (!map.getSource("route")) {
      map.addSource("route", { type: "geojson", data: empty });
      map.addSource("pulse", { type: "geojson", data: empty });
      map.addLayer({
        id: "route-casing", type: "line", source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 11, "line-opacity": 0.95 },
      });
      map.addLayer({
        id: "route-main", type: "line", source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": ["case", ["==", ["get", "kind"], "through_building"], 9, 6],
          "line-color": [
            "case",
            ["==", ["get", "kind"], "through_building"], token("--map-shortcut"),
            ["==", ["get", "kind"], "approach"], "#9aa0a6",
            token("--map-route"),
          ],
          "line-dasharray": ["case", ["==", ["get", "kind"], "approach"], ["literal", [1.5, 1.5]], ["literal", [1, 0]]],
        },
      });
      map.addLayer({
        id: "route-pulse", type: "line", source: "pulse",
        layout: { "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.9 },
      });
    }

    const src = map.getSource("route") as maplibregl.GeoJSONSource;
    const pulseSrc = map.getSource("pulse") as maplibregl.GeoJSONSource;
    if (!route) { src.setData(empty); pulseSrc.setData(empty); return; }

    const features = route.segments.map((s) => ({
      type: "Feature" as const,
      properties: { kind: s.kind },
      geometry: { type: "LineString" as const, coordinates: s.points.map(([la, lo]) => [lo, la]) },
    }));
    src.setData({ type: "FeatureCollection", features });

    map.fitBounds(
      route.path.reduce(
        (b, [la, lo]) => b.extend([lo, la] as [number, number]),
        new maplibregl.LngLatBounds(
          [route.path[0][1], route.path[0][0]],
          [route.path[0][1], route.path[0][0]],
        ),
      ),
      { padding: { top: 150, bottom: Math.round(window.innerHeight * SNAPS[snap]) + 30, left: 50, right: 50 }, duration: 900 },
    );

    // 경로 위를 달리는 빛줄기
    const flat = route.path.map(([la, lo]) => [lo, la]);
    const TAIL = Math.max(5, Math.round(flat.length * 0.12));
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = ((now - t0) % 2400) / 2400;
      const head = Math.round(t * (flat.length + TAIL));
      const seg = flat.slice(Math.max(0, head - TAIL), head);
      pulseSrc.setData(
        seg.length >= 2
          ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: seg } }] }
          : empty,
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [map, route, snap]);

  /* ---------- 마커 ---------- */
  useEffect(() => {
    if (!map) return;
    const made: maplibregl.Marker[] = [];
    if (origin) {
      const el = document.createElement("div");
      el.className = "marker-dot";
      el.style.setProperty("--c", token("--map-route"));
      made.push(new maplibregl.Marker({ element: el }).setLngLat([origin.center[1], origin.center[0]]).addTo(map));
    }
    if (dest) {
      const el = document.createElement("div");
      el.className = "marker-pin";
      el.style.setProperty("--c", token("--map-ink"));
      el.innerHTML = `<span>${dest.code}</span>`;
      made.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([dest.center[1], dest.center[0]]).addTo(map));
    }
    return () => made.forEach((m) => m.remove());
  }, [map, origin, dest]);

  /* ---------- 지도 탭으로 목적지 고르기 ---------- */
  const pick = useCallback((code: string) => {
    setQuery(`${code}101`);
    setSnap((s) => Math.max(s, 1)); // 지도를 찍었으면 결과를 보여줘야 한다
  }, []);
  useEffect(() => {
    if (!map) return;
    const h = (e: maplibregl.MapMouseEvent) => {
      const near = nearestBuilding([e.lngLat.lat, e.lngLat.lng], 70);
      if (near) pick(near.code);
    };
    map.on("click", h);
    return () => { map.off("click", h); };
  }, [map, pick]);

  const swap = () => {
    if (!toCode) return;
    const prev = fromCode;
    setFromCode(toCode);
    setQuery(getBuilding(prev)?.name ?? prev);
  };
  const locate = () => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const near = nearestBuilding([p.coords.latitude, p.coords.longitude]);
        if (near) setFromCode(near.code);
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div className="relative h-dvh overflow-hidden bg-background">
      {/* MapLibre 는 컨테이너에 position:relative 를 강제한다.
          바깥 div 가 자리를 잡고 안쪽 div 를 지도에 넘겨야 높이가 안 접힌다. */}
      <div className="absolute inset-0">
        <div className="h-full w-full" ref={box} />
      </div>

      <div className="absolute inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-20">
        <div className="flex items-center gap-1 rounded-2xl border bg-card/95 p-1.5 shadow-lg backdrop-blur-sm">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 px-1.5">
              <span className="size-2 shrink-0 rounded-full bg-primary" />
              <Select value={fromCode} onValueChange={(v) => v && setFromCode(v)}>
                <SelectTrigger aria-label="출발 건물"
                  className="h-8 w-full border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent [&>svg]:hidden">
                  <SelectValue>{origin?.name ?? "건물 선택"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {buildings.map((b) => (
                    <SelectItem key={b.code} value={b.code}>
                      {b.name} <span className="text-muted-foreground">.{b.code}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-[1.4rem] h-px bg-border" />
            <div className="flex items-center gap-2 px-1.5">
              <span className="size-2 shrink-0 rounded-full bg-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="강의실 코드 (U524, 9115 …)" aria-label="목적지 강의실" autoComplete="off"
                className="h-8 border-0 bg-transparent px-0 !text-sm shadow-none focus-visible:ring-0 dark:bg-transparent" />
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={swap} aria-label="출발지와 목적지 바꾸기"
                  className="size-9 shrink-0 rounded-full text-muted-foreground">
            <ArrowUpDown className="size-4" />
          </Button>
        </div>
      </div>

      <Button variant="secondary" size="icon" onClick={locate} disabled={locating}
        aria-label="현재 위치에서 출발"
        className="absolute right-3 z-20 size-11 rounded-full border bg-card shadow-lg transition-[bottom] duration-300"
        style={{ bottom: `calc(${SNAPS[snap] * 100}dvh + 0.75rem)` }}>
        <LocateFixed className={`size-5 ${locating ? "animate-pulse text-primary" : ""}`} />
      </Button>

      <Sheet snap={snap} setSnap={setSnap}>
        {parsed.ok ? (
          <p className="text-[13px] font-medium text-muted-foreground">
            <span className="text-foreground">{dest?.name}</span>
            {parsed.floor !== null && ` ${parsed.floor}층`}
            <span className="ml-1.5 font-normal">{parsed.normalized}</span>
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Search className="size-3.5" />{describe(parsed)}
          </p>
        )}

        {route ? (
          <>
            <div className="mt-1 flex items-baseline gap-2.5">
              <span className="text-[2.6rem] leading-[0.95] font-extrabold tracking-[-0.03em] tabular-nums">
                {formatDuration(route.seconds)}
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">{route.meters}m</span>
            </div>
            <Composition route={route} />
          </>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">경로를 계산할 수 없습니다</p>
        )}

        <div className="mt-4 flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Opt icon={<CloudRain />} label="비 안 맞는 길" on={!!opts.preferIndoor}
               onChange={(v) => setOpts((o) => ({ ...o, preferIndoor: v }))} />
          <Opt icon={<Accessibility />} label="계단 없는 길" on={!!opts.stepFree}
               onChange={(v) => setOpts((o) => ({ ...o, stepFree: v }))} />
          <Opt icon={<Split />} label="지름길 끄기" on={!!opts.noShortcut}
               onChange={(v) => setOpts((o) => ({ ...o, noShortcut: v }))} />
        </div>

        {steps.length > 0 && <StepList steps={steps} />}

      </Sheet>
    </div>
  );
}

function Opt({ icon, label, on, onChange }: {
  icon: React.ReactNode; label: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <Toggle size="sm" pressed={on} onPressedChange={onChange} aria-label={label}
      className="h-8 shrink-0 rounded-full border bg-card px-3 text-[12.5px] whitespace-nowrap data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
      {icon}{label}
    </Toggle>
  );
}
