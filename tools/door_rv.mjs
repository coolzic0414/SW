/**
 * 로드뷰로 출입구 찾기.
 *
 * 위성은 지붕만 보여서 문이 안 보인다. 건물 주변 로드뷰 촬영 지점마다 건물 쪽을 둘러 찍고,
 * 화면 위에 '방위각' 눈금을 그린다. 문이 보이면 그 방위각을 읽어서
 *   촬영 지점 → 방위각 방향 반직선 이 건물 외곽선(또는 다른 촬영 지점의 반직선)과 만나는 점
 * 을 문으로 잡는다 (tools/door_rv.py).
 *
 *   node tools/door_rv.mjs U            # 건물 둘러보기
 *   node tools/door_rv.mjs U aim 2:135 4:342   # 지점:방위각 들을 화면 정중앙에 놓고 확대해 확인
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const OUT = `${process.env.OUT_DIR ?? "tmp"}/rv`;
mkdirSync(OUT, { recursive: true });
const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];
const BLDS = JSON.parse(readFileSync("data/buildings.json", "utf8")).buildings;
const [code, mode, aimIdx, aimPan] = process.argv.slice(2);
const b = BLDS.find((x) => x.code === code);
const W = 800, H = 450;
// 줌별 초점거리(px). 화각 측정값으로 맞췄다 (줌 0 ≈ 80°, 2 ≈ 64°). 가장자리는 몇 도 틀릴 수 있어 확인은 aim 으로.
const FOCAL = { 0: 470, 2: 640 };

const br = await chromium.launch();
const p = await br.newPage({ viewport: { width: W, height: H } });
await p.goto("http://localhost:5173/");
await p.setContent(`<style>body{margin:0}#r{width:${W}px;height:${H}px}</style><div id="r"></div>
<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>`);
await p.waitForFunction(() => window.kakao?.maps?.load);
await p.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));
await p.evaluate(() => {
  const { kakao } = window;
  window.RV = new kakao.maps.Roadview(document.getElementById("r"));
  window.RVC = new kakao.maps.RoadviewClient();
  window.ready = null;
  const fire = () => { const f = window.ready; window.ready = null; f && f(); };
  kakao.maps.event.addListener(window.RV, "init", fire);
  kakao.maps.event.addListener(window.RV, "panoid_changed", fire);
  window.goPano = (id, la, lo) => new Promise((res) => {
    if (window.RV.getPanoId && window.RV.getPanoId() === id) { const q = window.RV.getPosition(); return res([q.getLat(), q.getLng()]); }
    const t = setTimeout(() => { window.ready = null; res(null); }, 8000);
    window.ready = () => { clearTimeout(t); setTimeout(() => { const q = window.RV.getPosition(); res([q.getLat(), q.getLng()]); }, 200); };
    window.RV.setPanoId(id, new kakao.maps.LatLng(la, lo));
  });
});

const K = 111320 * Math.cos((b.center[0] * Math.PI) / 180);
const bearing = (from, to) => ((Math.atan2((to[1] - from[1]) * K, (to[0] - from[0]) * 111320) * 180) / Math.PI + 360) % 360;
const panoPath = `${OUT}/${code}-panos.json`;

async function shot(pan, zoom, file, title) {
  await p.evaluate(([pan, zoom]) => window.RV.setViewpoint({ pan, tilt: 0, zoom }), [pan, zoom]);
  await p.waitForTimeout(1700);
  const img = (await p.locator("#r").screenshot()).toString("base64");
  const f = FOCAL[zoom];
  const ticks = [];
  for (let d = -60; d <= 60; d += 5) {
    const x = W / 2 + f * Math.tan((d * Math.PI) / 180);
    if (x < 0 || x > W) continue;
    const ang = (((pan + d) % 360) + 360) % 360;
    ticks.push(`<i style="left:${x}px;height:${d % 10 ? 8 : 16}px"></i>` +
      (d % 10 ? "" : `<u style="left:${x - 12}px">${Math.round(ang)}°</u>`));
  }
  return `<div class="f"><img src="data:image/png;base64,${img}">${ticks.join("")}
    <b style="left:${W / 2}px"></b><em>${title}</em></div>`;
}

async function sheet(frames, file) {
  await p.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:${W}px ${W}px;gap:4px;width:max-content}
    .f{position:relative;width:${W}px;height:${H}px}.f img{display:block}
    .f i{position:absolute;top:0;width:2px;background:#ff0;box-shadow:0 0 2px #000}
    .f u{position:absolute;top:16px;font:700 12px sans-serif;color:#ff0;text-decoration:none;text-shadow:0 0 3px #000,0 0 3px #000}
    .f b{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,0,0,.6)}
    .f em{position:absolute;left:6px;bottom:6px;font:700 13px sans-serif;color:#fff;background:rgba(0,0,0,.75);padding:2px 6px;font-style:normal}
    </style>${frames.join("")}`);
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${OUT}/${file}`, fullPage: true });
}

if (mode === "aim") {
  const panos = JSON.parse(readFileSync(panoPath, "utf8"));
  const frames = [];
  for (const spec of process.argv.slice(4)) {
    const [i, pan] = spec.split(":").map(Number);
    const pn = panos[i];
    const ok = await p.evaluate(([id, la, lo]) => window.goPano(id, la, lo), [pn.id, pn.at[0], pn.at[1]]);
    if (!ok) { console.log(`  ! 지점 ${i} 로드뷰를 못 불러와 건너뜀`); continue; }
    frames.push(await shot(pan, 2, "", `${code} 지점 ${i} · 정중앙 ${pan}°`));
  }
  await sheet(frames, `${code}-aim.png`);
  console.log(`→ ${code}-aim.png (${frames.length}장)`);
} else {
  // 건물 둘레 바깥에서 촬영 지점을 모은다 (서로 15m 이상 떨어진 것만)
  const ring = b.polygon?.length >= 3 ? b.polygon : [b.center];
  const probes = [];
  for (const push of [10, 25, 45, 65])
    for (let k = 0; k < 16; k++) {
      const q = ring[Math.floor((k * ring.length) / 16)] ?? b.center;
      const dy = q[0] - b.center[0], dx = q[1] - b.center[1];
      const L = Math.hypot(dy * 111320, dx * K) || 1;
      probes.push([q[0] + (dy * 111320 / L) * push / 111320, q[1] + (dx * K / L) * push / K]);
    }
  const panos = [];
  const seen = new Set();
  for (const q of probes) {
    const id = await p.evaluate(([la, lo]) => new Promise((r) =>
      window.RVC.getNearestPanoId(new window.kakao.maps.LatLng(la, lo), 40, r)), q);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const at = await p.evaluate(([id, la, lo]) => window.goPano(id, la, lo), [id, q[0], q[1]]);
    if (!at) continue;
    if (panos.some((x) => Math.hypot((x.at[0] - at[0]) * 111320, (x.at[1] - at[1]) * K) < 15)) continue;
    if (Math.hypot((at[0] - b.center[0]) * 111320, (at[1] - b.center[1]) * K) > 110) continue;
    panos.push({ id, at });
  }
  writeFileSync(panoPath, JSON.stringify(panos, null, 2));
  // 지점마다 건물이 보이는 각도 범위를 덮도록 몇 장씩
  const frames = [];
  for (const [i, pn] of panos.entries()) {
    const ok = await p.evaluate(([id, la, lo]) => window.goPano(id, la, lo), [pn.id, pn.at[0], pn.at[1]]);
    if (!ok) continue;
    const angs = ring.map((q) => bearing(pn.at, q));
    const c = bearing(pn.at, b.center);
    const rel = angs.map((a) => ((a - c + 540) % 360) - 180);
    const lo = Math.min(...rel), hi = Math.max(...rel);
    const pans = [];
    for (let d = lo + 35; d < hi + 35; d += 70) pans.push((c + Math.min(d, hi) + 360) % 360);
    if (!pans.length) pans.push(c);
    for (const pan of pans)
      frames.push(await shot(pan, 0, "", `${code} 지점 ${i} (${pn.at[0].toFixed(5)},${pn.at[1].toFixed(5)}) · 가운데 ${Math.round(pan)}°`));
  }
  await sheet(frames, `${code}-look.png`);
  console.log(`촬영 지점 ${panos.length}곳, ${frames.length}장 → ${code}-look.png`);
  panos.forEach((x, i) => console.log(`  지점 ${i}: ${x.at[0].toFixed(6)},${x.at[1].toFixed(6)}  건물 중심 방향 ${bearing(x.at, b.center).toFixed(0)}°`));
}
await br.close();
