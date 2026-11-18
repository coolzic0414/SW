/**
 * 카카오 지도에는 그려져 있는데 우리 그래프에는 없는 길을 찾는다.
 *
 * 눈으로 비교하면 놓친다. 그래서 픽셀로 센다.
 *   1) 지도만 찍는다. 카카오는 도로를 '무채색 회색'(r=g=b)으로, 캠퍼스 바닥·숲·건물은
 *      푸른기가 도는 색으로 칠한다. 이 차이로 도로 픽셀을 골라낸다.
 *   2) 같은 화면에 우리 그래프를 굵은 선으로 깔아 마스크를 만든다.
 *   3) 도로 픽셀인데 마스크에 안 덮인 곳 = 우리가 모르는 길.
 *
 *   node tools/missing_roads.mjs 36.7702 126.9328 2
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = `${process.env.OUT_DIR ?? "tmp"}`;
const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];
const g = JSON.parse(readFileSync("data/outdoor-graph.json", "utf8"));

const [lat, lon, level = "2", tag = ""] = process.argv.slice(2);
const W = 900, H = 900;
// 이 굵기 안에 들어오면 '아는 길' 로 친다. 확대할수록 1px 이 작아지니 함께 키운다.
// 좁게 잡으면 도로 가장자리·건물 외곽선까지 '모르는 길' 로 잡혀 쓸모가 없어진다.
const METERS_PER_PX = 0.125 * 2 ** (+level - 1);
const TOLERANCE_PX = Math.round(7 / METERS_PER_PX);   // 중심선에서 7m

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto("http://localhost:5173/");
await page.setContent(`
  <style>body{margin:0}#m{width:${W}px;height:${H}px}</style><div id="m"></div>
  <script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>
`);
await page.waitForFunction(() => window.kakao?.maps?.load, null, { timeout: 30000 });
await page.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));
await page.evaluate(({ lat, lon, level }) => {
  const { kakao } = window;
  window.M = new kakao.maps.Map(document.getElementById("m"), {
    center: new kakao.maps.LatLng(+lat, +lon), level: +level,
  });
}, { lat, lon, level });
await page.waitForTimeout(3500);

const bounds = await page.evaluate(() => {
  const b = window.M.getBounds();
  return { s: b.getSouthWest().getLat(), w: b.getSouthWest().getLng(),
           n: b.getNorthEast().getLat(), e: b.getNorthEast().getLng() };
});
await page.locator("#m").screenshot({ path: `${OUT}/mr-map${tag}.png` });

// 그래프를 화면 좌표로 바꾼다. 카카오 투영을 그대로 쓰려고 지도에게 물어본다.
const lines = await page.evaluate(({ g }) => {
  const { kakao } = window;
  const proj = window.M.getProjection();
  const px = ([a, b]) => {
    const p = proj.containerPointFromCoords(new kakao.maps.LatLng(a, b));
    return [Math.round(p.x), Math.round(p.y)];
  };
  return g.edges
    .filter((e) => e.kind !== "indoor")
    .map((e) => (e.geom ?? [
      [g.nodes[e.from].lat, g.nodes[e.from].lon],
      [g.nodes[e.to].lat, g.nodes[e.to].lon],
    ]).map(px));
}, { g });

await page.setContent(`
  <style>body{margin:0;background:#000}svg{display:block}</style>
  <svg width="${W}" height="${H}">
    ${lines.map((pts) =>
      `<polyline points="${pts.map((p) => p.join(",")).join(" ")}"
         fill="none" stroke="#fff" stroke-width="${TOLERANCE_PX * 2}"
         stroke-linecap="round" stroke-linejoin="round"/>`).join("")}
  </svg>
`);
await page.waitForTimeout(200);
await page.locator("svg").screenshot({ path: `${OUT}/mr-mask${tag}.png` });

writeFileSync(`${OUT}/mr-meta${tag}.json`, JSON.stringify({ bounds, w: W, h: H }, null, 2));
await browser.close();
console.log("지도·마스크 저장 완료");
