/**
 * 건물마다 위성사진(Esri World Imagery, z18)에서 지붕 색을 뽑아 data/building-colors.json 에 적는다.
 * 실사 지도에서 입체 건물을 그 색으로 칠하려고 쓴다.
 *
 *   node tools/building_colors.mjs
 *
 * 건물 외곽선 안쪽(가장자리 1.5m 안쪽으로 줄인 영역)의 화소를 모아 채널별 중앙값을 쓴다.
 * 그림자(아주 어두운 화소)와 반사(아주 밝은 화소)는 빼고, 남는 게 너무 적으면 전부 쓴다.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const Z = 18, T = 256;
const buildings = JSON.parse(readFileSync("data/buildings.json", "utf8")).buildings.filter((b) => b.polygon?.length >= 3);
const px = (lat, lon) => {
  const n = 2 ** Z * T, s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};

const br = await chromium.launch();
const page = await br.newPage();
await page.setContent("<canvas id=c></canvas>");
const out = {};
for (const b of buildings) {
  const pts = b.polygon.map(([la, lo]) => px(la, lo));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const tx0 = Math.floor(Math.min(...xs) / T), tx1 = Math.floor(Math.max(...xs) / T);
  const ty0 = Math.floor(Math.min(...ys) / T), ty1 = Math.floor(Math.max(...ys) / T);
  const hex = await page.evaluate(async ({ pts, tx0, tx1, ty0, ty1, Z, T }) => {
    const c = document.getElementById("c"), g = c.getContext("2d", { willReadFrequently: true });
    c.width = (tx1 - tx0 + 1) * T; c.height = (ty1 - ty0 + 1) * T;
    const load = (x, y) => new Promise((ok, no) => {
      const im = new Image(); im.crossOrigin = "anonymous";
      im.onload = () => { g.drawImage(im, (x - tx0) * T, (y - ty0) * T); ok(); }; im.onerror = no;
      im.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${y}/${x}`;
    });
    const jobs = [];
    for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) jobs.push(load(x, y));
    await Promise.all(jobs);
    const local = pts.map(([x, y]) => [x - tx0 * T, y - ty0 * T]);
    const path = new Path2D(); local.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath();
    // z18 화소 ≈ 0.48m. 가장자리 3화소(≈1.5m)는 벽·그림자가 섞이니 뺀다.
    g.lineWidth = 6;
    const img = g.getImageData(0, 0, c.width, c.height).data;
    const keep = [], all = [];
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (!g.isPointInPath(path, x + 0.5, y + 0.5) || g.isPointInStroke(path, x + 0.5, y + 0.5)) continue;
      const i = (y * c.width + x) * 4, r = img[i], gg = img[i + 1], bb = img[i + 2];
      const l = 0.299 * r + 0.587 * gg + 0.114 * bb;
      all.push([r, gg, bb]);
      if (l > 45 && l < 235) keep.push([r, gg, bb]);
    }
    const use = keep.length >= 20 ? keep : all;
    if (!use.length) return null;
    const med = (k) => { const v = use.map((p) => p[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
    return "#" + [0, 1, 2].map((k) => med(k).toString(16).padStart(2, "0")).join("");
  }, { pts, tx0, tx1, ty0, ty1, Z, T });
  if (hex) out[b.code] = hex;
  console.log(`  ${b.name.padEnd(12)} ${hex ?? "못 뽑음"}`);
}
await br.close();
writeFileSync("data/building-colors.json", JSON.stringify({
  _what: "건물별 지붕 색 (위성사진 Esri World Imagery z18 에서 외곽선 안쪽 화소의 중앙값). tools/building_colors.mjs 가 만든다.",
  colors: out,
}, null, 2) + "\n");
console.log(`→ data/building-colors.json (${Object.keys(out).length}곳)`);
