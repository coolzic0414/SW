/**
 * 출입구 다시 보기 — 건물마다 최대 해상도 스카이뷰에 '지금 찍힌 문' 과 외곽선을 겹쳐 찍는다.
 *
 * 격자 라벨은 '이미지 픽셀' 기준이다. 화면 배율을 머리로 환산하다 틀리는 일을 없애려고
 * 집은 픽셀을 그대로 tools/door_pick.py 에 넣으면 좌표가 된다.
 *
 *   node tools/door_review.mjs U 9 ML      # 건물 코드들 (없으면 전부)
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const OUT = `${process.env.OUT_DIR ?? "tmp"}/review`;
mkdirSync(OUT, { recursive: true });
const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];
const BLDS = JSON.parse(readFileSync("data/buildings.json", "utf8")).buildings;
const DOORS = JSON.parse(readFileSync("data/doors.json", "utf8")).doors;
const G = JSON.parse(readFileSync("data/outdoor-graph.json", "utf8"));

const CSS = 750, DSF = 2, IMG = CSS * DSF;
const args = process.argv.slice(2);
const targets = args.length ? BLDS.filter((b) => args.includes(b.code)) : BLDS;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: CSS, height: CSS }, deviceScaleFactor: DSF });
await page.goto("http://localhost:5173/");
await page.setContent(`<style>body{margin:0}#m{width:${CSS}px;height:${CSS}px}</style><div id="m"></div>
<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>`);
await page.waitForFunction(() => window.kakao?.maps?.load);
await page.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));
await page.evaluate(() => {
  const { kakao } = window;
  window.M = new kakao.maps.Map(document.getElementById("m"), { center: new kakao.maps.LatLng(36.77, 126.932), level: 1 });
  window.M.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
  window.drawn = [];
});

const metaPath = `${OUT}/meta.json`;
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};

for (const b of targets) {
  const ring = b.polygon?.length >= 3 ? b.polygon : null;
  // 건물이 화면에 들어오도록 가운데에 놓는다 (레벨 1 = 이 화면에서 약 190m)
  const c = ring
    ? [(Math.min(...ring.map((p) => p[0])) + Math.max(...ring.map((p) => p[0]))) / 2,
       (Math.min(...ring.map((p) => p[1])) + Math.max(...ring.map((p) => p[1]))) / 2]
    : b.center;
  const doors = DOORS.filter((d) => d.code === b.code);
  // 로드뷰 촬영 지점 (tools/door_rv.mjs 가 남긴 것) — 어느 지점이 어느 면을 보는지 알려고
  const panoFile = `${OUT}/../rv/${b.code}-panos.json`;
  const panos = existsSync(panoFile) ? JSON.parse(readFileSync(panoFile, "utf8")) : [];
  // 지금 그래프에서 이 건물 문에 붙은 길(접근로)도 같이 그린다
  const roads = G.edges.filter((e) => e.kind !== "indoor" && (e.geom?.length ?? 0) > 1)
    .map((e) => ({ geom: e.geom, kind: e.kind }));
  await page.evaluate(({ c, ring, doors, roads, panos }) => {
    const { kakao } = window;
    window.drawn.forEach((o) => o.setMap(null)); window.drawn = [];
    const add = (o) => { o.setMap(window.M); window.drawn.push(o); };
    window.M.setCenter(new kakao.maps.LatLng(c[0], c[1]));
    for (const r of roads) add(new kakao.maps.Polyline({
      path: r.geom.map(([a, b]) => new kakao.maps.LatLng(a, b)),
      strokeWeight: r.kind === "approach" ? 1.5 : 2, strokeColor: r.kind === "approach" ? "#cbd5e1" : "#22c55e",
      strokeOpacity: 0.7, strokeStyle: r.kind === "approach" ? "shortdash" : "solid" }));
    if (ring) add(new kakao.maps.Polygon({ path: ring.map(([a, b]) => new kakao.maps.LatLng(a, b)),
      strokeWeight: 1.5, strokeColor: "#ff7a1a", strokeOpacity: 0.9, fillOpacity: 0 }));
    doors.forEach((d) => add(new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(d.at[0], d.at[1]), zIndex: 9,
      content: `<div style="position:relative;width:12px;height:12px;border-radius:9999px;background:#ef4444;border:2px solid #fff;box-sizing:border-box">
        <span style="position:absolute;left:15px;top:-3px;white-space:nowrap;font:700 11px sans-serif;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000">${d.label}</span></div>` })));
    panos.forEach((pn, i) => add(new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(pn.at[0], pn.at[1]), zIndex: 8,
      content: `<div style="box-sizing:border-box;width:18px;height:18px;border-radius:9999px;
        background:#2563eb;color:#fff;border:2px solid #fff;font:700 10px sans-serif;display:grid;place-items:center">${i}</div>` })));
  }, { c, ring, doors, roads, panos });
  await page.waitForTimeout(2600);
  const bd = await page.evaluate(() => {
    const d = window.M.getBounds();
    return { s: d.getSouthWest().getLat(), w: d.getSouthWest().getLng(), n: d.getNorthEast().getLat(), e: d.getNorthEast().getLng() };
  });
  const shot = (await page.locator("#m").screenshot()).toString("base64");

  // 이미지 픽셀 기준 격자 (100px 마다, 라벨도 이미지 픽셀)
  const lines = [];
  for (let v = 100; v < IMG; v += 100) {
    lines.push(`<i style="left:${v / DSF}px;top:0;width:1px;height:${CSS}px"></i><u style="left:${v / DSF + 2}px;top:2px">${v}</u>`);
    lines.push(`<i style="left:0;top:${v / DSF}px;width:${CSS}px;height:1px"></i><u style="left:2px;top:${v / DSF + 2}px">${v}</u>`);
  }
  const mPerPx = ((bd.e - bd.w) * 111320 * Math.cos((c[0] * Math.PI) / 180)) / IMG;
  await page.setContent(`<style>
    body{margin:0}.w{position:relative;width:${CSS}px;height:${CSS}px}.w img{width:${CSS}px;height:${CSS}px;display:block}
    .w i{position:absolute;background:rgba(255,255,255,.25)}
    .w u{position:absolute;font:9px sans-serif;color:#fff;text-decoration:none;text-shadow:0 0 2px #000,0 0 2px #000}
    .hd{position:absolute;left:4px;bottom:4px;background:rgba(0,0,0,.8);color:#fff;font:600 10px sans-serif;padding:3px 6px;border-radius:4px}
    </style><div class="w"><img src="data:image/png;base64,${shot}">${lines.join("")}
    <div class="hd">${b.name} (${b.code}) · 격자 = 이미지 픽셀 · 1px ≈ ${mPerPx.toFixed(3)}m · 빨강 = 지금 찍힌 문 · 파랑 = 로드뷰 지점 · 주황 = 외곽선 · 위가 북쪽</div></div>`);
  await page.waitForTimeout(150);
  await page.locator(".w").screenshot({ path: `${OUT}/${b.code}.png` });
  meta[b.code] = { name: b.name, bounds: bd, w: IMG, h: IMG, mPerPx };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`${b.code} ${b.name} — 지금 문 ${doors.length}개`);
  // 지도 문서로 되돌린다
  await page.goto("http://localhost:5173/");
  await page.setContent(`<style>body{margin:0}#m{width:${CSS}px;height:${CSS}px}</style><div id="m"></div>
  <script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>`);
  await page.waitForFunction(() => window.kakao?.maps?.load);
  await page.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));
  await page.evaluate(() => {
    const { kakao } = window;
    window.M = new kakao.maps.Map(document.getElementById("m"), { center: new kakao.maps.LatLng(36.77, 126.932), level: 1 });
    window.M.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
    window.drawn = [];
  });
}
await browser.close();
