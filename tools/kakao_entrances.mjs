/**
 * 카카오 지도에 그려진 '건물 출입구' 표시(문 + 화살표 아이콘)를 캠퍼스 전체에서 모은다.
 *
 * 카카오는 최대 확대(레벨 1)에서 건물 출입구에 작은 회색 아이콘을 그린다.
 * OSM 에는 출입구가 0개라, 공개된 지도에서 문 위치를 얻는 유일한 경로다.
 *
 * 캠퍼스를 타일로 나눠 찍기만 하고, 아이콘 검출은 tools/kakao_entrances.py 가 한다.
 *   node tools/kakao_entrances.mjs
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = `${process.env.OUT_DIR ?? "tmp"}/ent`;
mkdirSync(OUT, { recursive: true });
const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];

// 캠퍼스 건물 범위 + 여유
const S0 = 36.7666, N0 = 36.7730, W0 = 126.9266, E0 = 126.9356;
const PX = 600, DSF = 3;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: PX, height: PX }, deviceScaleFactor: DSF });
await p.goto("http://localhost:5173/");
await p.setContent(`<style>body{margin:0}#m{width:${PX}px;height:${PX}px}</style><div id="m"></div>
<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>`);
await p.waitForFunction(() => window.kakao?.maps?.load);
await p.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));
await p.evaluate(([la, lo]) => {
  const { kakao } = window;
  window.M = new kakao.maps.Map(document.getElementById("m"), { center: new kakao.maps.LatLng(la, lo), level: 1 });
}, [S0, W0]);
await p.waitForTimeout(1500);

// 한 타일이 덮는 범위를 재서 격자를 짠다 (겹치게 — 가장자리에 걸린 아이콘을 놓치지 않으려고)
const span = await p.evaluate(() => {
  const d = window.M.getBounds();
  return [d.getNorthEast().getLat() - d.getSouthWest().getLat(), d.getNorthEast().getLng() - d.getSouthWest().getLng()];
});
const stepLat = span[0] * 0.85, stepLon = span[1] * 0.85;
const tiles = [];
for (let la = S0 + span[0] / 2; la - span[0] / 2 < N0; la += stepLat)
  for (let lo = W0 + span[1] / 2; lo - span[1] / 2 < E0; lo += stepLon) tiles.push([la, lo]);

const meta = [];
for (const [i, [la, lo]] of tiles.entries()) {
  await p.evaluate(([la, lo]) => window.M.setCenter(new window.kakao.maps.LatLng(la, lo)), [la, lo]);
  await p.waitForTimeout(1800);
  const bd = await p.evaluate(() => {
    const d = window.M.getBounds();
    return { s: d.getSouthWest().getLat(), w: d.getSouthWest().getLng(), n: d.getNorthEast().getLat(), e: d.getNorthEast().getLng() };
  });
  const file = `t${String(i).padStart(2, "0")}.png`;
  await p.locator("#m").screenshot({ path: `${OUT}/${file}` });
  meta.push({ file, bounds: bd, w: PX * DSF, h: PX * DSF });
}
writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));
await b.close();
console.log(`타일 ${tiles.length}장 → ${OUT}`);
