/**
 * 그래프를 카카오 지도 위에 겹쳐 그린다 — '지도엔 길이 보이는데 경로가 안 쓴다' 를 가려내는 도구.
 *
 * 초록 = 우리가 아는 길, 빨강 = 계단, 파랑 = 수동으로 넣은 길, 회색 = 건물 접근로.
 * 지도에 길이 보이는데 겹친 선이 없으면 OSM 에 그 길이 없는 것이다.
 *
 *   node tools/graph_overlay.mjs 36.7701 126.9327 4     # 중심 위도 경도 [레벨]
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = `${process.env.OUT_DIR ?? "tmp"}`;
const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];
const g = JSON.parse(readFileSync("data/outdoor-graph.json", "utf8"));

const [lat, lon, level = "4", sky = "0", clean = "0"] = process.argv.slice(2);
const W = 900, H = 900;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.goto("http://localhost:5173/");
await page.setContent(`
  <style>body{margin:0}#m{width:${W}px;height:${H}px}</style><div id="m"></div>
  <script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>
`);
await page.waitForFunction(() => window.kakao?.maps?.load, null, { timeout: 30000 });
await page.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));

await page.evaluate(({ g, lat, lon, level, sky }) => {
  const { kakao } = window;
  const map = window.__m = new kakao.maps.Map(document.getElementById("m"), {
    center: new kakao.maps.LatLng(+lat, +lon), level: +level,
  });
  if (sky === "1") map.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);

  const color = (e) =>
    e.kind === "steps" ? "#dc2626"
    : e.kind === "escalator" ? "#9333ea"
    : e.kind === "through_building" ? "#f59e0b"
    : e.kind === "approach" ? "#94a3b8"
    : e.kind === "indoor" ? "#cbd5e1"
    : e.source === "knowledge" ? "#2563eb"
    : "#16a34a";

  for (const e of g.edges) {
    const pts = e.geom ?? [
      [g.nodes[e.from].lat, g.nodes[e.from].lon],
      [g.nodes[e.to].lat, g.nodes[e.to].lon],
    ];
    new kakao.maps.Polyline({
      map,
      path: pts.map(([a, b]) => new kakao.maps.LatLng(a, b)),
      strokeWeight: e.kind === "approach" || e.kind === "indoor" ? 2 : 4,
      strokeColor: color(e),
      strokeOpacity: 0.85,
      strokeStyle: e.kind === "indoor" ? "shortdash" : "solid",
    });
  }
  // 길과 길이 만나는 점. 여기가 없으면 두 길이 이어지지 않는다.
  for (const [id, n] of Object.entries(g.nodes)) {
    if (id.startsWith("b:") || /^(ds|do|d):/.test(id)) continue;
    new kakao.maps.CustomOverlay({
      map, position: new kakao.maps.LatLng(n.lat, n.lon), zIndex: 3,
      content: '<div style="box-sizing:border-box;width:5px;height:5px;'
        + 'border-radius:9999px;background:#111;border:1px solid #fff"></div>',
    });
  }
}, { g: clean === "1" ? { nodes: {}, edges: [] } : g, lat, lon, level, sky });

await page.waitForTimeout(3000);

// 빠진 길을 좌표로 집을 수 있게 픽셀 격자를 덮는다 (survey_capture 와 같은 방식)
const bb = await page.evaluate(() => {
  const b = window.__m.getBounds();
  return { s: b.getSouthWest().getLat(), w: b.getSouthWest().getLng(),
           n: b.getNorthEast().getLat(), e: b.getNorthEast().getLng() };
});
const shot = (await page.locator("#m").screenshot()).toString("base64");
const grid = [];
for (let x = 100; x < W; x += 100)
  grid.push(`<i style="left:${x}px;top:0;width:1px;height:${H}px"></i>`,
            `<u style="left:${x + 3}px;top:3px">${x}</u>`);
for (let y = 100; y < H; y += 100)
  grid.push(`<i style="left:0;top:${y}px;width:${W}px;height:1px"></i>`,
            `<u style="left:3px;top:${y + 3}px">${y}</u>`);
const mPerPx = ((bb.e - bb.w) * 111320 * Math.cos((+lat * Math.PI) / 180)) / W;
await page.setContent(`
  <style>
    body{margin:0;background:#000;font:12px -apple-system,sans-serif;color:#fff}
    .w{position:relative;width:${W}px;height:${H}px}
    .w img{display:block;width:${W}px;height:${H}px}
    .w i{position:absolute;background:rgba(0,0,0,.18)}
    .w u{position:absolute;font-size:9px;color:#000;text-decoration:none;
         text-shadow:0 0 3px #fff,0 0 3px #fff}
    .hd{position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.8);
        padding:4px 8px;border-radius:6px;font-size:11px}
  </style>
  <div class="w"><img src="data:image/png;base64,${shot}">${grid.join("")}
    <div class="hd">초록=아는 길 · 빨강=계단 · 파랑=손으로 넣은 길 · 보라=에스컬레이터 ·
      주황=건물 관통 · 1px ≈ ${mPerPx.toFixed(3)}m</div></div>
`);
await page.waitForTimeout(200);
await page.locator(".w").screenshot({ path: `${OUT}/overlay.png` });
writeFileSync(`${OUT}/overlay.json`, JSON.stringify({ bounds: bb, w: W, h: H }, null, 2));
await browser.close();
console.log(`→ ${OUT}/overlay.png  (bounds 는 overlay.json)`);
