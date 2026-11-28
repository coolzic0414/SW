/**
 * 3D 지도 부품 (MapLibre). 앱 본체(App.tsx)는 그대로이고 지도에 그리는 부분만 이걸로 바꿔 끼운다.
 * 카카오 부품(App.tsx 의 useMapOverlays · useLookOverlays)이 하는 일을 하나씩 똑같이 한다.
 *
 *   바탕: OpenFreeMap 'dark' 스타일을 테마별 색으로 다시 칠함 (키 없음)
 *   지형: AWS 공개 고도 데이터(terrarium) — 캠퍼스 언덕이 솟는다
 *   건물: 입체. 출발(파랑)·도착(빨강)·지름길로 통과(주황)는 색으로 강조
 *   로드뷰는 여전히 카카오 SDK 로 그린다 (지도와 별개)
 */
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { buildings, graph, nearestBuilding, routeFromHere, formatDuration, type CampusRoute } from "../lib/campus.ts";
import { loadSdk } from "../useKakaoMap.ts";
import { token, crossedBuildings, dist, SNAPS, pinLabel, type MapKit, type OpeningOpts, type Theme } from "../App.tsx";

maplibregl.setWorkerUrl(workerUrl);

type LL = [number, number];
const CAMPUS: LL = [36.77004, 126.93192];
const ll = ([la, lo]: LL) => [lo, la] as [number, number];

/**
 * 카메라 각도. 55°는 건물이 길을 가려 잘 안 보였다 — 40°가 입체감과 읽기 쉬움의 균형.
 * 방향은 남쪽을 본다(165°). 캠퍼스는 남쪽(향설생활관·글로벌빌리지)이 높아서, 북쪽을 보면 높은 데서
 * 내리막을 내려다보는 꼴이라 비탈 뒤가 가려진다. 낮은 북쪽에서 언덕을 올려다봐야 비탈이 카메라를 향해 선다.
 */
const PITCH = 40, BEARING = 165;

const PAL = {
  dark: {
    bg: "#06080b", water: "#0a1220", green: "#0b100e", road: "#1f262f", casing: "#0b0d11", place: "#5b6372", placeHalo: "#06080b",
    city: "#0e1218", campus: "#1a2130", campusText: "#aeb8c9", halo: "#06080b",
    cap: "#8fb0e8", walk: "#344259", foot: "rgba(79,141,255,0.30)", footTo: "rgba(255,77,90,0.95)", footFrom: "rgba(96,160,255,0.9)",
    shadow: "#000000", highlight: "#1f2633", accent: "#05070a", sky: "#05070b", horizon: "#1a2436", fog: "#070a10", light: 0.4,
    to: "#7a1f2a", from: "#1f3f7a", crossed: "#7a4a12", toCap: "#ff8a93", fromCap: "#9cc2ff", crossedCap: "#ffc477",
  },
  // 밝은 지도 — 바탕·건물을 거의 흰색으로, 그림자로만 입체를 읽게
  light: {
    bg: "#ffffff", water: "#d4e4f4", green: "#eef4eb", road: "#eceff3", casing: "#e0e4ea", place: "#8a909c", placeHalo: "#ffffff",
    city: "#f1f2f4", campus: "#eef1f5", campusText: "#2b313b", halo: "#ffffff",
    cap: "#ffffff", walk: "#e2e6ec", foot: "rgba(20,30,50,0.10)", footTo: "rgba(229,72,77,0.7)", footFrom: "rgba(59,130,246,0.6)",
    shadow: "#b3bbc7", highlight: "#ffffff", accent: "#e6e9ee", sky: "#f2f5f9", horizon: "#ffffff", fog: "#ffffff", light: 0.32,
    to: "#f6b3ae", from: "#bcd3f7", crossed: "#f8d7a6", toCap: "#e5484d", fromCap: "#3b82f6", crossedCap: "#f59e0b",
  },
  // 실사 — 위성사진(Esri) 위에 캠퍼스 건물만 입체로
  satellite: {
    bg: "#0b0d10", water: "#0b0d10", green: "#0b0d10", road: "#ffffff", casing: "#000000", place: "#ffffff", placeHalo: "#000000",
    city: "#d9d4ca", campus: "#e9e4da", campusText: "#ffffff", halo: "#000000",
    cap: "#ffffff", walk: "rgba(255,255,255,0.5)", foot: "rgba(0,0,0,0.35)", footTo: "rgba(255,77,90,0.95)", footFrom: "rgba(96,160,255,0.9)",
    shadow: "#000000", highlight: "#ffffff", accent: "#000000", sky: "#9fb8d6", horizon: "#dfe8f2", fog: "#cfd9e4", light: 0.3,
    to: "#c2414c", from: "#3b6fd6", crossed: "#d08a2a", toCap: "#ff8a93", fromCap: "#9cc2ff", crossedCap: "#ffc477",
  },
} as const;

const isDarkLook = (t: Theme) => t !== "light";

/** 캠퍼스를 감싸는 볼록 껍질 (그 안의 OSM 건물은 우리 건물로 대신 세운다) */
function hull(): [number, number][] {
  const pts = buildings.flatMap((b) => b.polygon).map(ll).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...pts].reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const h = [...lo.slice(0, -1), ...up.slice(0, -1)];
  return [...h, h[0]];
}

/** 건물 높이(m). 실측이 없어 대략값, 길을 가리지 않게 낮춰 잡는다 */
const HEIGHT: Record<string, number> = {
  RC: 18, "@향설생활관2": 18, "@향설생활관3": 18, "@학성사1": 15, "@학성사2": 15, "@학성사3": 15, "@글로벌빌리지": 13,
  L: 13, U: 15, ML: 14, M: 12, "9": 13, G: 9, R: 6, "@교직원식당": 5, "@학생회관": 10, "@대학본부": 10,
};

const EMPTY = { type: "FeatureCollection" as const, features: [] };
const OP_MAX = 6;   // 첫 화면 연출 경로 수 (자주 가는 곳 5 + 여유)

/** 지도에 HTML 말풍선을 단다. 지도 엔진이 바깥 상자의 transform 으로 위치를 잡으므로 애니메이션은 안쪽에 둔다. */
function mark(map: maplibregl.Map, html: string, at: LL, anchor: maplibregl.PositionAnchor = "center", offset: [number, number] = [0, 0]) {
  const el = document.createElement("div");
  el.innerHTML = html;
  el.style.pointerEvents = "none";
  return new maplibregl.Marker({ element: el, anchor, offset }).setLngLat(ll(at)).addTo(map);
}

/** 원(미터)을 다각형으로 — 위치 오차 표시용 */
function circle(c: LL, r: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push([c[1] + (r * Math.sin(a)) / (111320 * Math.cos((c[0] * Math.PI) / 180)), c[0] + (r * Math.cos(a)) / 111320]);
  }
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [pts] } };
}

/* ---------------- 지도 만들기 ---------------- */

function setup(m: maplibregl.Map) {
  if (m.getLayer("building")) m.setLayoutProperty("building", "visibility", "none");
  for (const l of m.getStyle().layers) {
    if (l.type === "symbol" && (l.id.startsWith("highway_name") || l.id.startsWith("water_name") || l.id.startsWith("road_"))) {
      m.setLayoutProperty(l.id, "visibility", "none");
    }
  }
  const dem = { type: "raster-dem" as const, tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
                tileSize: 256, encoding: "terrarium" as const, maxzoom: 15 };
  m.addSource("dem", dem);
  m.addSource("dem-shade", dem);
  m.setTerrain({ source: "dem", exaggeration: 1.4 });
  m.addLayer({ id: "hillshade", type: "hillshade", source: "dem-shade", paint: { "hillshade-exaggeration": 0.5 } }, "water");
  // 실사용 위성사진 (다른 모양에선 꺼 둔다). 땅 위 칠하기보다 위, 도로·건물보다 아래.
  m.addSource("sat", { type: "raster", tileSize: 256, maxzoom: 18,
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] });
  const firstLine = m.getStyle().layers.find((l) => l.type === "line")?.id;
  m.addLayer({ id: "sat", type: "raster", source: "sat", layout: { visibility: "none" },
    paint: { "raster-saturation": -0.15, "raster-contrast": 0.05 } }, firstLine);

  const campusHull = { type: "Polygon" as const, coordinates: [hull()] };
  m.addLayer({ id: "city-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 13,
    filter: ["!", ["within", campusHull]] as never,
    paint: { "fill-extrusion-height": ["*", 0.6, ["coalesce", ["get", "render_height"], 8]],
             "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0], "fill-extrusion-opacity": 0.95,
             "fill-extrusion-vertical-gradient": true } });

  const fc = { type: "FeatureCollection" as const, features: buildings.filter((b) => b.polygon.length >= 3).map((b) => ({
    type: "Feature" as const, properties: { code: b.code, h: HEIGHT[b.code] ?? 10 },
    geometry: { type: "Polygon" as const, coordinates: [[...b.polygon.map(ll), ll(b.polygon[0])]] } })) };
  m.addSource("campus", { type: "geojson", data: fc });

  // 캠퍼스 보행로망 — 길찾기에 쓰는 바로 그 길들. 가는 선으로 깔아 '설계된 지도' 느낌을 낸다
  const edges = graph.edges as unknown as { kind?: string; indoor?: boolean; geom?: LL[] }[];
  const walk = { type: "FeatureCollection" as const, features: edges
    .filter((e) => e.kind !== "approach" && !e.indoor && (e.geom?.length ?? 0) >= 2)
    .map((e) => ({ type: "Feature" as const, properties: {},
                   geometry: { type: "LineString" as const, coordinates: e.geom!.map(ll) } })) };
  m.addSource("campus-walk", { type: "geojson", data: walk });
  m.addLayer({ id: "campus-walk", type: "line", source: "campus-walk", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 17, 2.2, 19, 4] } });
  // 건물 바닥 윤곽에 번지는 빛
  m.addLayer({ id: "campus-foot", type: "line", source: "campus",
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 17, 9], "line-blur": ["interpolate", ["linear"], ["zoom"], 14, 2, 17, 8] } });

  m.addLayer({ id: "campus-3d", type: "fill-extrusion", source: "campus",
    paint: { "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 1,
             "fill-extrusion-vertical-gradient": true } });
  // 지붕 테두리 — 지붕 가장자리에만 얇은 고리를 얹어 윤곽선이 빛나 보이게 한다
  const RIM = 1.1;   // 테두리 폭(m)
  // 변마다 안쪽으로 얇은 띠를 만든다 (오목한 건물도 모양이 안 깨진다)
  const rim = { type: "FeatureCollection" as const, features: fc.features.flatMap((f) => {
    const ring = f.geometry.coordinates[0];
    const cy = ring[0][1], kx = 111320 * Math.cos((cy * Math.PI) / 180), ky = 110540;
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    const inward = area > 0 ? 1 : -1;   // 반시계면 왼쪽이 안쪽
    const out = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      const dx = (bx - ax) * kx, dy = (by - ay) * ky, L = Math.hypot(dx, dy);
      if (L < 0.5) continue;
      const nx = (-dy / L) * RIM * inward / kx, ny = (dx / L) * RIM * inward / ky;
      out.push({ type: "Feature" as const, properties: f.properties,
        geometry: { type: "Polygon" as const, coordinates: [[[ax, ay], [bx, by], [bx + nx, by + ny], [ax + nx, ay + ny], [ax, ay]]] } });
    }
    return out;
  }) };
  m.addSource("campus-rim", { type: "geojson", data: rim });
  m.addLayer({ id: "campus-cap", type: "fill-extrusion", source: "campus-rim",
    paint: { "fill-extrusion-height": ["+", ["get", "h"], 0.35], "fill-extrusion-base": ["get", "h"], "fill-extrusion-opacity": 1,
             "fill-extrusion-vertical-gradient": false } });

  const pts = { type: "FeatureCollection" as const, features: buildings.map((b) => ({
    type: "Feature" as const, properties: { code: b.code, name: b.name.replace(/^SCH/, "") },
    geometry: { type: "Point" as const, coordinates: ll(b.center) } })) };
  m.addSource("campus-pt", { type: "geojson", data: pts });
  m.addLayer({ id: "campus-label", type: "symbol", source: "campus-pt", minzoom: 15,
    layout: { "text-field": ["get", "name"], "text-size": 12, "text-letter-spacing": 0.04, "text-font": ["Noto Sans Regular"] } });

  // 경로·일반 길·오차 원 (데이터는 그릴 때 채운다)
  for (const id of ["ov-route", "ov-base", "ov-acc"]) m.addSource(id, { type: "geojson", data: EMPTY });
  m.addLayer({ id: "ov-acc", type: "fill", source: "ov-acc", paint: { "fill-color": "#2563eb", "fill-opacity": 0.1 } });
  m.addLayer({ id: "ov-base", type: "line", source: "ov-base", layout: { "line-cap": "butt", "line-join": "round" },
    paint: { "line-width": 4.5, "line-dasharray": [1.6, 1.2] } });
  const solid = ["!=", ["get", "kind"], "approach"] as never;
  m.addLayer({ id: "ov-glow", type: "line", source: "ov-route", filter: solid, layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": 22, "line-blur": 13 } });
  m.addLayer({ id: "ov-edge", type: "line", source: "ov-route", filter: solid, layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": 10 } });
  m.addLayer({ id: "ov-core", type: "line", source: "ov-route", filter: solid, layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": 6.5 } });
  m.addLayer({ id: "ov-flow", type: "line", source: "ov-route", filter: solid, layout: { "line-cap": "butt", "line-join": "round" },
    paint: { "line-width": 2.6, "line-color": "#ffffff", "line-dasharray": [0, 4, 3] } });
  m.addLayer({ id: "ov-approach", type: "line", source: "ov-route", filter: ["==", ["get", "kind"], "approach"] as never,
    layout: { "line-cap": "round" }, paint: { "line-width": 3.5, "line-dasharray": [0.4, 1.8], "line-opacity": 0.9 } });

  // 첫 화면 연출 경로
  for (let i = 0; i < OP_MAX; i++) {
    m.addSource(`op${i}`, { type: "geojson", data: EMPTY });
    m.addLayer({ id: `op${i}-glow`, type: "line", source: `op${i}`, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ff8a1a", "line-width": 22, "line-blur": 14 } });
    m.addLayer({ id: `op${i}-core`, type: "line", source: `op${i}`, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-width": 4.2 } });
  }
}

/** 테마별 색 칠하기. 테마를 바꾸면 다시 부른다. */
function paint(m: maplibregl.Map, theme: Theme) {
  const P = PAL[theme], dark = isDarkLook(theme), sat = theme === "satellite";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (id: string, prop: string, v: unknown) => { if (m.getLayer(id)) (m.setPaintProperty as any)(id, prop, v); };
  set("background", "background-color", P.bg);
  set("water", "fill-color", P.water);
  for (const id of ["landcover_wood", "landuse_park", "landuse_residential"]) set(id, "fill-color", P.green);
  for (const l of m.getStyle().layers) {
    if (l.type === "line" && l.id.startsWith("highway")) set(l.id, "line-color", l.id.includes("casing") ? P.casing : P.road);
    if (l.type === "symbol" && l.id.startsWith("place")) { set(l.id, "text-color", P.place); set(l.id, "text-halo-color", P.placeHalo); }
    // 실사: 바탕 칠하기·도로·주변 입체 건물은 사진과 겹치니 끈다
    const base = l.type === "fill" && l.id !== "building" && !l.id.startsWith("ov-") && !l.id.startsWith("campus");
    if (base || (l.type === "line" && l.id.startsWith("highway")) || l.id === "hillshade" || l.id === "city-3d")
      m.setLayoutProperty(l.id, "visibility", sat ? "none" : "visible");
  }
  m.setLayoutProperty("sat", "visibility", sat ? "visible" : "none");
  set("hillshade", "hillshade-shadow-color", P.shadow);
  set("hillshade", "hillshade-highlight-color", P.highlight);
  set("hillshade", "hillshade-accent-color", P.accent);
  set("city-3d", "fill-extrusion-color", P.city);
  set("campus-walk", "line-color", P.walk);
  set("campus-walk", "line-opacity", dark ? 0.9 : 0.95);
  set("ov-flow", "line-opacity", dark ? 0.7 : 0.6);
  set("campus-label", "text-color", P.campusText);
  set("campus-label", "text-halo-color", P.halo);
  set("campus-label", "text-halo-width", 1.4);
  for (let i = 0; i < OP_MAX; i++) {
    set(`op${i}-glow`, "line-opacity", dark ? 0.6 : 0.35);
    set(`op${i}-core`, "line-color", dark ? "#ffd6a0" : "#e46a00");
  }
  m.setLight({ anchor: "map", color: dark ? "#e6ecff" : "#ffffff", intensity: P.light, position: [1.4, 215, 38] });
  m.setSky({ "sky-color": P.sky, "horizon-color": P.horizon, "fog-color": P.fog,
             "fog-ground-blend": 0.45, "horizon-fog-blend": 0.8, "sky-horizon-blend": 0.6, "atmosphere-blend": 0 });
}

function useApexMap(_side: boolean, theme: Theme) {
  const ref = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 로드뷰는 카카오 SDK 로 그린다 (지도와 별개)
  useEffect(() => {
    const key = import.meta.env.VITE_KAKAO_JS_KEY;
    if (key) loadSdk(key).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ref.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: ref.current, style: "https://tiles.openfreemap.org/styles/dark",
        center: ll(CAMPUS), zoom: 13, pitch: 0, bearing: 0, maxPitch: 70,
        // 한글은 지도 글꼴에 없으니 기기 글꼴로 그린다
        localIdeographFontFamily: "'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif",
        attributionControl: false,   // 출처는 앱의 표기(시트 위)에 넣었다
      });
    } catch (e) { setError(`3D 지도를 띄우지 못했습니다: ${(e as Error).message}`); return; }
    m.on("error", (e) => console.error("지도 오류:", e.error?.message ?? e));
    m.on("load", () => { setup(m); setMap(m); });
    // 화면 가장자리를 살짝 어둡게 (말풍선보다 아래에 깔리도록 지금 붙인다)
    const vignette = document.createElement("div");
    vignette.className = "apex-vignette";
    m.getContainer().appendChild(vignette);
    if (import.meta.env.DEV) (window as unknown as { __map?: unknown }).__map = m;
    const el = ref.current;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el);
    return () => { ro.disconnect(); m.remove(); };
  }, []);

  useEffect(() => { if (map) paint(map, theme); }, [map, theme]);
  return { ref, map, error };
}

/* ---------------- 경로·건물·말풍선 (카카오 useMapOverlays 와 같은 일) ---------------- */

function useApexOverlays(
  map: maplibregl.Map | null, route: CampusRoute | null, fromCode: string | null, toCode: string | null,
  snap: number, onPick: (code: string) => void,
  here: LL | null, accuracy: number, fromHere: boolean,
  baseline: CampusRoute | null, theme: Theme, side = false,
) {
  const markers = useRef<maplibregl.Marker[]>([]);
  const raf = useRef<number | undefined>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;

  // 건물을 누르면 목적지. 입체 건물은 지붕을 눌러도 그 건물로 잡히게 먼저 건물 면을 본다.
  useEffect(() => {
    if (!map) return;
    const click = (e: maplibregl.MapMouseEvent) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ["campus-3d"] })[0];
      const code = (f?.properties?.code as string | undefined) ?? nearestBuilding([e.lngLat.lat, e.lngLat.lng], 70)?.code;
      if (code) pick.current(code);
    };
    const enter = () => { map.getCanvas().style.cursor = "pointer"; };
    const leave = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", click);
    map.on("mouseenter", "campus-3d", enter);
    map.on("mouseleave", "campus-3d", leave);
    return () => { map.off("click", click); map.off("mouseenter", "campus-3d", enter); map.off("mouseleave", "campus-3d", leave); };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    if (raf.current) cancelAnimationFrame(raf.current);
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    const add = (mk: maplibregl.Marker) => markers.current.push(mk);
    const P = PAL[theme];
    const dark = isDarkLook(theme);
    const primary = token("--map-route"), ink = token("--map-ink"), shortcut = token("--map-shortcut");
    const crossed = route ? crossedBuildings(route) : [];

    // 건물: 도착 빨강 · 출발 파랑 · 지름길로 통과 주황 (카카오 판의 면 칠하기와 같은 뜻)
    map.setPaintProperty("campus-3d", "fill-extrusion-color", ["case",
      ["==", ["get", "code"], toCode ?? "__"], P.to,
      ["==", ["get", "code"], fromCode ?? "__"], P.from,
      ["in", ["get", "code"], ["literal", crossed]], P.crossed,
      P.campus] as never);
    map.setPaintProperty("campus-cap", "fill-extrusion-color", ["case",
      ["==", ["get", "code"], toCode ?? "__"], P.toCap,
      ["==", ["get", "code"], fromCode ?? "__"], P.fromCap,
      ["in", ["get", "code"], ["literal", crossed]], P.crossedCap,
      P.cap] as never);
    map.setPaintProperty("campus-foot", "line-color", ["case",
      ["==", ["get", "code"], toCode ?? "__"], P.footTo,
      ["==", ["get", "code"], fromCode ?? "__"], P.footFrom,
      P.foot] as never);
    // 도착 건물 이름은 핀이 대신 보여준다 (겹치지 않게)
    map.setFilter("campus-label", ["!=", ["get", "code"], toCode ?? "__"] as never);

    // 선 색 (테마 토큰 그대로)
    const kindColor = (through: string, normal: string) => ["case", ["==", ["get", "kind"], "through_building"], through, normal] as never;
    map.setPaintProperty("ov-glow", "line-color", kindColor(shortcut, primary));
    map.setPaintProperty("ov-glow", "line-opacity", dark ? 0.5 : 0.25);
    map.setPaintProperty("ov-edge", "line-color", kindColor(token("--map-shortcut-edge"), token("--map-route-edge")));
    map.setPaintProperty("ov-core", "line-color", kindColor(shortcut, primary));
    map.setPaintProperty("ov-approach", "line-color", token("--map-label"));
    map.setPaintProperty("ov-base", "line-color", token("--map-baseline"));

    const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource;
    src("ov-base").setData(baseline
      ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: baseline.path.map(ll) } } : EMPTY);
    src("ov-acc").setData(here && fromHere && accuracy > 8 && accuracy < 200 ? circle(here, accuracy) : EMPTY);
    src("ov-route").setData(EMPTY);

    // 경로 위로 빛이 흐른다 (점선 모양을 차례로 바꿔 끼워 움직이게 한다)
    const FLOW = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
                  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
    let flowStep = -1;
    const flow = route ? window.setInterval(() => {
      flowStep = (flowStep + 1) % FLOW.length;
      if (map.getLayer("ov-flow")) map.setPaintProperty("ov-flow", "line-dasharray", FLOW[flowStep]);
    }, 70) : undefined;

    if (route) {
      // 출발지에서 도착지로 그려 나간다 (카카오 판과 같은 650ms)
      const segs = route.segments.map((s) => ({ kind: s.kind, pts: s.points.map(ll) }));
      const total = segs.reduce((n, s) => n + s.pts.length, 0);
      const DRAW = 650, t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / DRAW);
        let budget = Math.ceil((1 - Math.pow(1 - p, 3)) * total);
        const features = [];
        for (const s of segs) {
          const take = Math.max(0, Math.min(s.pts.length, budget));
          budget -= s.pts.length;
          if (take >= 2) features.push({ type: "Feature" as const, properties: { kind: s.kind },
                                         geometry: { type: "LineString" as const, coordinates: s.pts.slice(0, take) } });
        }
        src("ov-route").setData({ type: "FeatureCollection", features });
        if (p < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);

      // 말풍선 둘 — 관통 지점 '몇 분 단축', 일반 길이 가장 멀리 벌어진 곳 '일반 길 몇 분'
      if (baseline) {
        const mid = route.segments.find((s) => s.kind === "through_building");
        if (mid) {
          const at = mid.points[Math.floor(mid.points.length / 2)];
          add(mark(map, `<div class="map-badge map-badge-shortcut"><b>⚡</b>${formatDuration(baseline.seconds - route.seconds)} 단축</div>`, at, "bottom", [0, -10]));
        }
        const bp = baseline.path;
        const acc = [0];
        for (let i = 1; i < bp.length; i++) acc.push(acc[i - 1] + dist(bp[i - 1], bp[i]));
        const L = acc[acc.length - 1] || 1;
        let far = bp[0], farD = -1;
        for (let i = 0; i < bp.length; i++) {
          if (acc[i] / L < 0.3 || acc[i] / L > 0.7) continue;
          const d = Math.min(...route.path.map((r) => dist(bp[i], r)));
          if (d > farD) { farD = d; far = bp[i]; }
        }
        if (farD > 25) add(mark(map, `<div class="map-badge map-badge-base">일반 길 ${Math.max(1, Math.round(baseline.seconds / 60))}분</div>`, far));
      }
    }

    // 내 위치 · 출발 점 · 도착 핀
    if (here && fromHere) add(mark(map, '<div class="me-dot"></div>', here));
    const from = fromCode && !(fromHere && !route) ? buildings.find((b) => b.code === fromCode) : null;
    if (from && !(fromHere && here)) add(mark(map, `<div class="marker-dot" style="--c:${primary}"></div>`, from.center));
    const to = toCode ? buildings.find((b) => b.code === toCode) : null;
    if (to) add(mark(map, `<div class="marker-pin" style="--c:${ink}"><span>${pinLabel(to)}</span></div>`, to.center, "bottom"));

    // 경로 전체가 보이게 — 위는 검색 카드, 아래는 시트(폰), 왼쪽은 패널(PC)
    if (route) {
      const all = [...route.path, ...(baseline?.path ?? []), ...(here && fromHere ? [here] : [])].map(ll);
      const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
      const h = window.innerHeight;
      const bottom = Math.min(Math.round(h * SNAPS[snap]) + 24, Math.round(h * 0.45));
      // 첫 화면 연출이 남긴 여백이 지도에 붙어 있으면 여기 여백과 합쳐져 화면을 넘는다 (폰에서 멀리 빠짐)
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      map.fitBounds(b, { padding: side ? { left: 470, top: 90, right: 70, bottom: 70 } : { top: 160, bottom, left: 50, right: 50 },
                         pitch: PITCH, bearing: BEARING, maxZoom: 17.8, duration: 900 });
    }
    return () => { if (raf.current) cancelAnimationFrame(raf.current); if (flow) clearInterval(flow); };
  }, [map, route, fromCode, toCode, snap, here, accuracy, fromHere, baseline, theme, side]);
}

/* ---------------- 첫 화면 연출 (카카오 H 와 같은 순서) ---------------- */

function useApexOpening(map: maplibregl.Map | null, o: OpeningOpts) {
  const flown = useRef(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const frames = useRef<number[]>([]);
  // 위치를 3초까지만 기다린다. 그 뒤엔 위치 없이(길 없이) 날아 들어온다.
  const [patience, setPatience] = useState(false);
  useEffect(() => { const t = setTimeout(() => setPatience(true), 3000); return () => clearTimeout(t); }, []);
  const blocked = !!o.waiting && !patience;
  const itemsKey = o.items.map((i) => i.code + i.seconds).join();

  useEffect(() => {
    const clear = () => {
      frames.current.forEach(cancelAnimationFrame); frames.current = [];
      markers.current.forEach((x) => x.remove()); markers.current = [];
      if (map) for (let i = 0; i < OP_MAX; i++) (map.getSource(`op${i}`) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
    };
    clear();
    if (!map || !o.active || (blocked && !flown.current)) return clear;

    const here = o.here;
    const lines = here ? o.items.flatMap((it) => {
      const r = routeFromHere(here, it.code);
      return r ? [{ it, coords: r.path.map(ll) }] : [];
    }).slice(0, OP_MAX) : [];
    const all = lines.length && here ? [ll(here), ...lines.flatMap((l) => l.coords)] : hull();
    const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
    const cam = {
      center: b.getCenter(), zoom: o.side ? 16.35 : 15.55, pitch: PITCH, bearing: BEARING,
      padding: o.side ? { left: 430, top: 40, right: 40, bottom: 40 } : { top: 130, bottom: Math.round(window.innerHeight * 0.255) + 20, left: 16, right: 16 },
    };

    const sprout = (fast: boolean) => lines.forEach((l, i) => {
      const start = performance.now() + (fast ? 0 : i * 240), DUR = fast ? 450 : 1000;
      const tick = (now: number) => {
        const p = Math.max(0, Math.min(1, (now - start) / DUR));
        const n = Math.max(2, Math.ceil((1 - Math.pow(1 - p, 3)) * l.coords.length));
        (map.getSource(`op${i}`) as maplibregl.GeoJSONSource)?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l.coords.slice(0, n) } });
        if (p < 1) frames.current.push(requestAnimationFrame(tick));
        else {
          const last = l.coords[l.coords.length - 1];
          markers.current.push(mark(map, `<div class="eta-pin" style="--c:${l.it.color}"><i></i>${l.it.name}<b>${
            l.it.seconds !== null ? Math.max(1, Math.round(l.it.seconds / 60)) + "분" : ""}</b></div>`, [last[1], last[0]], "bottom", [0, -6]));
        }
      };
      frames.current.push(requestAnimationFrame(tick));
    });

    if (!flown.current) {
      // 멀리서 날아 들어온다 (MapLibre 는 확대·회전이 원래 매끄럽다)
      flown.current = true;
      map.jumpTo({ center: b.getCenter(), zoom: 12.6, pitch: 0, bearing: 0 });
      map.flyTo({ ...cam, duration: 3000, curve: 1.5, essential: true });
      map.once("moveend", () => sprout(false));
    } else {
      map.easeTo({ ...cam, duration: 700 });
      sprout(true);
    }
    return clear;
  }, [map, o.active, o.here?.[0], o.here?.[1], o.side, itemsKey, blocked]);
}

export const APEX_KIT: MapKit = {
  useMap: (side, theme) => useApexMap(side, theme),
  useOverlays: useApexOverlays as MapKit["useOverlays"],
  useOpening: (map, o) => useApexOpening(map, o),
  panTo: (map, at) => (map as maplibregl.Map).easeTo({ center: ll(at), duration: 600 }),
  credit: (theme) => theme === "satellite"
    ? "위성 © Esri, Maxar · 지도 © OpenFreeMap · OpenStreetMap 기여자"
    : "지도 © OpenFreeMap · OpenMapTiles · OpenStreetMap 기여자",
  themeKey: "theme-choice-3d", themeDefault: "dark",
  hideUntilOpening: false,
};
