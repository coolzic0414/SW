/**
 * 건물의 '각 벽면을 정면에서' 로드뷰로 본다.
 *
 * 모서리 근처 촬영 지점은 벽을 비스듬히만 봐서 문을 놓친다(공학관 남동쪽 문이 그랬다).
 * 외곽선의 면마다 그 앞 10~30m 에서 촬영 지점을 찾아, 벽을 정면으로 바라보게 찍는다.
 * 촬영 지점은 rv/<코드>-panos.json 에 이어 붙이므로 door_rv.py pano 로 번호를 그대로 쓴다.
 *
 *   node tools/door_faces.mjs 1 2 5
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RV = `${process.env.OUT_DIR ?? "tmp"}/rv`;
const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];
const BLDS = JSON.parse(readFileSync("data/buildings.json", "utf8")).buildings;
const W = 800, H = 450, FOCAL = 640;     // 줌 2

const br = await chromium.launch();
const p = await br.newPage({ viewport: { width: W, height: H } });
async function boot() {
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
    window.near = (la, lo, r) => new Promise((res) => window.RVC.getNearestPanoId(new kakao.maps.LatLng(la, lo), r, res));
  });
}

for (const code of process.argv.slice(2)) {
  const b = BLDS.find((x) => x.code === code);
  const ring = b.polygon;
  if (!ring || ring.length < 3) { console.log(`${code}: 외곽선 없음 — 건너뜀`); continue; }
  await boot();
  const K = 111320 * Math.cos((b.center[0] * Math.PI) / 180);
  const toXY = (q) => [(q[1] - b.center[1]) * K, (q[0] - b.center[0]) * 111320];
  const toLL = (x, y) => [b.center[0] + y / 111320, b.center[1] + x / K];
  const bearing = (a, c) => ((Math.atan2((c[1] - a[1]) * K, (c[0] - a[0]) * 111320) * 180) / Math.PI + 360) % 360;

  // 면 만들기: 거의 일직선인 변은 합치고 8m 미만은 버린다
  const pts = ring.map(toXY);
  let faces = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], c = pts[(i + 1) % pts.length];
    faces.push([a, c]);
  }
  const ang = (f) => Math.atan2(f[1][1] - f[0][1], f[1][0] - f[0][0]);
  const merged = [];
  for (const f of faces) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(((ang(last) - ang(f) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < 0.26) last[1] = f[1];
    else merged.push([...f]);
  }
  faces = merged.filter((f) => Math.hypot(f[1][0] - f[0][0], f[1][1] - f[0][1]) >= 8);

  const panoFile = `${RV}/${code}-panos.json`;
  const panos = existsSync(panoFile) ? JSON.parse(readFileSync(panoFile, "utf8")) : [];
  const frames = [];
  for (const [fi, f] of faces.entries()) {
    const [a, c] = f;
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const ux = (c[0] - a[0]) / L, uy = (c[1] - a[1]) / L;
    let nx = -uy, ny = ux;                           // 바깥쪽 법선
    const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    if (nx * mid[0] + ny * mid[1] < 0) { nx = -nx; ny = -ny; }
    const faceBearing = ((Math.atan2(-nx, -ny) * 180) / Math.PI + 360) % 360;   // 벽을 바라보는 방향
    const outward = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
    const dirName = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"][Math.round(outward / 45) % 8];
    // 면 앞쪽으로 여러 점을 찍어 촬영 지점을 찾는다
    const found = [];
    const step = Math.max(8, L / Math.ceil(L / 14));
    for (let s = Math.min(4, L / 2); s <= L - Math.min(4, L / 2) + 0.1; s += step)
      for (const off of [9, 18, 30]) {
        const q = toLL(a[0] + ux * s + nx * off, a[1] + uy * s + ny * off);
        const id = await p.evaluate(([la, lo]) => window.near(la, lo, 9), q);
        if (!id || found.some((x) => x.id === id)) continue;
        let known = panos.findIndex((x) => x.id === id);
        let at;
        if (known >= 0) at = panos[known].at;
        else {
          at = await p.evaluate(([id, la, lo]) => window.goPano(id, la, lo), [id, q[0], q[1]]);
          if (!at) continue;
          panos.push({ id, at }); known = panos.length - 1;
        }
        // 이 면 '앞' 에 있는가 (면을 따라 잰 위치가 면 범위 안, 바깥쪽)
        const [px, py] = toXY(at);
        const along = (px - a[0]) * ux + (py - a[1]) * uy, out = (px - a[0]) * nx + (py - a[1]) * ny;
        if (along < -4 || along > L + 4 || out < 2 || out > 40) continue;
        if (found.some((x) => Math.hypot(x.px - px, x.py - py) < 7)) continue;
        found.push({ id, idx: known, px, py, along });
      }
    found.sort((x, y) => x.along - y.along);
    // 면 하나에 최대 4장 — 고르게 떨어진 것으로
    const pick = found.length <= 4 ? found : [0, 1, 2, 3].map((k) => found[Math.round((k * (found.length - 1)) / 3)]);
    for (const fp of pick) {
      const loaded = await p.evaluate(([id, la, lo]) => window.goPano(id, la, lo), [fp.id, panos[fp.idx].at[0], panos[fp.idx].at[1]]);
      if (!loaded) { frames.push({ img: null, pan: 0, title: `${b.name} 면${fi} · 지점 ${fp.idx} — 로드뷰를 못 불러옴(건너뜀)` }); continue; }
      const pan = Math.round(faceBearing);
      await p.evaluate((pan) => window.RV.setViewpoint({ pan, tilt: 0, zoom: 2 }), pan);
      await p.waitForTimeout(1600);
      const img = (await p.locator("#r").screenshot()).toString("base64");
      frames.push({ img, pan, title: `${b.name} 면${fi}(${dirName}쪽) · 지점 ${fp.idx} · 정중앙 ${pan}°` });
    }
    if (!pick.length) frames.push({ img: null, pan: 0, title: `${b.name} 면${fi}(${dirName}쪽, ${L.toFixed(0)}m) — 앞에 로드뷰 없음` });
  }
  writeFileSync(panoFile, JSON.stringify(panos, null, 2));

  const html = frames.map((f) => {
    if (!f.img) return `<div class="f none"><em>${f.title}</em></div>`;
    const ticks = [];
    for (let d = -30; d <= 30; d += 5) {
      const x = W / 2 + FOCAL * Math.tan((d * Math.PI) / 180);
      ticks.push(`<i style="left:${x}px;height:${d % 10 ? 8 : 16}px"></i>` +
        (d % 10 ? "" : `<u style="left:${x - 12}px">${Math.round((f.pan + d + 360) % 360)}°</u>`));
    }
    return `<div class="f"><img src="data:image/png;base64,${f.img}">${ticks.join("")}<b></b><em>${f.title}</em></div>`;
  }).join("");
  await p.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:${W}px ${W}px;gap:4px;width:max-content}
    .f{position:relative;width:${W}px;height:${H}px;background:#222}.f img{display:block}
    .f i{position:absolute;top:0;width:2px;background:#ff0;box-shadow:0 0 2px #000}
    .f u{position:absolute;top:16px;font:700 12px sans-serif;color:#ff0;text-decoration:none;text-shadow:0 0 3px #000,0 0 3px #000}
    .f b{position:absolute;left:${W / 2}px;top:0;bottom:0;width:1px;background:rgba(255,0,0,.6)}
    .f em{position:absolute;left:6px;bottom:6px;font:700 13px sans-serif;color:#fff;background:rgba(0,0,0,.75);padding:2px 6px;font-style:normal}
    .none em{bottom:auto;top:200px}</style>${html}`);
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${RV}/${code}-faces.png`, fullPage: true });
  console.log(`${code} ${b.name}: 면 ${faces.length}개, 사진 ${frames.filter((f) => f.img).length}장`);
}
await br.close();
