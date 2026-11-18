/**
 * 건물별 '문 조사용 한 장' 만들기.
 *
 * 왼쪽에 스카이뷰(건물 외곽선 + 로드뷰 촬영 지점 + 픽셀 격자),
 * 오른쪽에 그 지점들에서 건물을 바라본 로드뷰.
 * 격자를 넣는 이유는 보고서 "문은 (430,610)" 처럼 자리를 집을 수 있게 하려는 것이다.
 * 집은 픽셀은 tools/survey_pick.py 가 저장된 bounds 로 위경도로 되돌린다.
 *
 *   node tools/survey_capture.mjs 9 U ML      # 건물 코드들
 *   node tools/survey_capture.mjs --all
 *
 * 주의: 카카오 로드뷰의 init 이벤트는 처음 한 번만 온다. 파노라마를 바꿀 때는
 *       panoid_changed 를 같이 들어야 한다. 안 그러면 두 번째부터 영원히 기다린다.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = `${process.env.OUT_DIR ?? "tmp"}/survey`;
mkdirSync(OUT, { recursive: true });

const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];
const BLDS = JSON.parse(readFileSync("data/buildings.json", "utf8")).buildings;

const W = 700, H = 700;      // 스카이뷰 (CSS px). 화면 배율 2배로 찍어 1400px 이 된다
const RW = 520, RH = 300;    // 로드뷰 한 장
const PAD = 18;              // 건물 둘레 여유 (m)
const MAX_RV = 4;            // 건물당 로드뷰 장수
const APART = 25;            // 촬영 지점끼리 최소 간격 (m)

const args = process.argv.slice(2);
const targets = args[0] === "--all" ? BLDS : BLDS.filter((b) => args.includes(b.code));
if (!targets.length) { console.error("건물 코드를 적어주세요"); process.exit(1); }

const SHELL = `
  <style>body{margin:0;background:#111}#sky{width:${W}px;height:${H}px}#rv{width:${RW}px;height:${RH}px}</style>
  <div id="sky"></div><div id="rv"></div>
  <script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>
`;

const browser = await chromium.launch();
// deviceScaleFactor 2 — 카카오가 레티나 타일을 주므로 해상도가 실제로 두 배가 된다.
// 문은 2m 남짓이라 0.25m/px 로는 8px 이고, 이래야 눈으로 가려낼 수 있다.
const page = await browser.newPage({
  viewport: { width: Math.max(W, RW * 2) + 40, height: Math.max(H, RH * 2) + 40 },
  deviceScaleFactor: 2,
});
page.on("console", (m) => m.type() === "error" && console.log("  ERR", m.text()));

/** 카카오 JS 키는 localhost:5173 에만 열려 있다. 그 출처 위에서 문서를 갈아끼운다. */
async function boot() {
  await page.goto("http://localhost:5173/");
  await page.setContent(SHELL);
  await page.waitForFunction(() => window.kakao?.maps?.load, null, { timeout: 30000 });
  await page.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));
  await page.evaluate(() => {
    const { kakao } = window;
    window.M = new kakao.maps.Map(document.getElementById("sky"), {
      center: new kakao.maps.LatLng(36.77, 126.932), level: 1,
    });
    window.M.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
    window.RV = new kakao.maps.Roadview(document.getElementById("rv"));
    window.RVC = new kakao.maps.RoadviewClient();
    window.drawn = [];

    // init 은 최초 1회뿐이라 panoid_changed 도 같이 듣는다
    window.ready = null;
    const fire = () => { const f = window.ready; window.ready = null; if (f) f(); };
    kakao.maps.event.addListener(window.RV, "init", fire);
    kakao.maps.event.addListener(window.RV, "panoid_changed", fire);

    window.goPano = (id, lat, lng) => new Promise((res) => {
      const t = setTimeout(() => { window.ready = null; res(null); }, 7000);
      window.ready = () => {
        clearTimeout(t);
        setTimeout(() => { const p = window.RV.getPosition(); res([p.getLat(), p.getLng()]); }, 150);
      };
      window.RV.setPanoId(id, new kakao.maps.LatLng(lat, lng));
    });

    /** 촬영 지점에서 건물 쪽을 바라보게 각도를 돌린다 */
    window.face = (lat, lng) => {
      const from = window.RV.getPosition();
      const dy = lat - from.getLat();
      const dx = (lng - from.getLng()) * Math.cos(lat * Math.PI / 180);
      window.RV.setViewpoint({ pan: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360, tilt: 2, zoom: 0 });
    };
  });
}


/** 점에서 가장 가까운 외곽선 위의 지점. 벽을 정면으로 보기 위한 조준점이다. */
function nearestOnRing(p, ring, mLat, mLon) {
  if (ring.length < 2) return ring[0] ?? p;
  let best = ring[0], bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const ax = (a[1] - p[1]) * mLon, ay = (a[0] - p[0]) * mLat;
    const cx = (c[1] - p[1]) * mLon, cy = (c[0] - p[0]) * mLat;
    const dx = cx - ax, dy = cy - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const qx = ax + dx * t, qy = ay + dy * t;
    const d = Math.hypot(qx, qy);
    if (d < bd) { bd = d; best = [p[0] + qy / mLat, p[1] + qx / mLon]; }
  }
  return best;
}

const meta = (() => { try { return JSON.parse(readFileSync(`${OUT}/meta.json`, "utf8")); } catch { return {}; } })();

await boot();

for (const b of targets) {
  process.stdout.write(`${b.code} ${b.name} … `);
  const mLat = 111320, mLon = 111320 * Math.cos((b.center[0] * Math.PI) / 180);
  const ring = b.polygon?.length >= 3 ? b.polygon : [b.center];

  // 1) 건물이 화면을 채우도록 줌을 맞춘다.
  //    setBounds 는 실제보다 두세 배 넓게 잡혀서, 필요한 폭을 재고 레벨을 직접 고른다.
  const lats = ring.map((p) => p[0]), lons = ring.map((p) => p[1]);
  const need = Math.max(
    (Math.max(...lats) - Math.min(...lats)) * mLat,
    (Math.max(...lons) - Math.min(...lons)) * mLon, 45) + PAD * 2;

  await page.evaluate(({ c, need }) => {
    const { kakao } = window;
    window.drawn.forEach((o) => o.setMap(null));
    window.drawn = [];
    window.M.setCenter(new kakao.maps.LatLng(c[0], c[1]));
    for (let lv = 1; lv <= 6; lv++) {
      window.M.setLevel(lv);
      const bd = window.M.getBounds();
      const span = (bd.getNorthEast().getLng() - bd.getSouthWest().getLng())
                 * 111320 * Math.cos(c[0] * Math.PI / 180);
      if (span >= need) break;
    }
  }, { c: b.center, need });

  // 2) 건물 둘레 바깥 여러 거리에서 로드뷰를 찾는다.
  //    한 길에서만 모이지 않도록 이미 고른 지점과 25m 넘게 떨어진 것만 받는다.
  const probes = [];
  for (const push of [14, 28, 44]) {
    for (let k = 0; k < 8; k++) {
      const p = ring[Math.floor((k * ring.length) / 8)] ?? b.center;
      const dy = p[0] - b.center[0], dx = p[1] - b.center[1];
      const len = Math.hypot(dy * mLat, dx * mLon) || 1;
      probes.push([p[0] + ((dy * mLat) / len) * push / mLat,
                   p[1] + ((dx * mLon) / len) * push / mLon]);
    }
  }

  const picked = [];
  const shots = [];
  const seen = new Set();
  for (const q of probes) {
    if (picked.length >= MAX_RV) break;
    const id = await page.evaluate(([lat, lng]) =>
      new Promise((r) => window.RVC.getNearestPanoId(
        new window.kakao.maps.LatLng(lat, lng), 70, r)), q);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const at = await page.evaluate(([id, lat, lng]) => window.goPano(id, lat, lng), [id, q[0], q[1]]);
    if (!at) continue;
    if (picked.some((p) => Math.hypot((p[0] - at[0]) * mLat, (p[1] - at[1]) * mLon) < APART)) continue;

    // 건물 중심이 아니라 카메라에서 가장 가까운 벽면을 정면으로 본다.
    // 중심을 보면 모서리만 잡혀서 문이 있는 면이 비스듬히 지나간다.
    const aim = nearestOnRing(at, ring, mLat, mLon);
    await page.evaluate(([lat, lng]) => window.face(lat, lng), aim);
    await page.waitForTimeout(1100);
    picked.push(at);
    shots.push((await page.locator("#rv").screenshot()).toString("base64"));
  }

  // 3) 외곽선과 촬영 지점을 그린 뒤 스카이뷰를 찍는다.
  //    촬영 지점을 같이 그려야 어느 로드뷰가 어느 면을 보는지 알 수 있다.
  await page.evaluate(({ ring, picked, hasRing }) => {
    const { kakao } = window;
    if (hasRing) {
      const poly = new kakao.maps.Polygon({
        path: ring.map(([la, lo]) => new kakao.maps.LatLng(la, lo)),
        strokeWeight: 2, strokeColor: "#ff7a1a", strokeOpacity: 1, fillOpacity: 0,
      });
      poly.setMap(window.M); window.drawn.push(poly);
    }
    picked.forEach((p, i) => {
      const o = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(p[0], p[1]),
        content: '<div style="box-sizing:border-box;width:21px;height:21px;'
          + 'border-radius:9999px;background:#2563eb;color:#fff;border:2px solid #fff;'
          + 'font:700 12px -apple-system,sans-serif;display:grid;place-items:center;'
          + 'box-shadow:0 1px 5px rgba(0,0,0,.6)">' + (i + 1) + '</div>',
        zIndex: 5,
      });
      o.setMap(window.M); window.drawn.push(o);
    });
  }, { ring, picked, hasRing: b.polygon?.length >= 3 });
  await page.waitForTimeout(1800);

  const bb = await page.evaluate(() => {
    const d = window.M.getBounds();
    return { s: d.getSouthWest().getLat(), w: d.getSouthWest().getLng(),
             n: d.getNorthEast().getLat(), e: d.getNorthEast().getLng() };
  });
  const sky = (await page.locator("#sky").screenshot()).toString("base64");

  // 4) 스카이뷰와 로드뷰를 따로 저장한다.
  //    한 장에 합치면 가로가 길어져 읽을 때 축소돼서, 해상도를 올린 의미가 없어진다.
  const grid = [];
  for (let x = 100; x < W; x += 100)
    grid.push(`<i style="left:${x}px;top:0;width:1px;height:${H}px"></i>`,
              `<u style="left:${x + 3}px;top:3px">${x}</u>`);
  for (let y = 100; y < H; y += 100)
    grid.push(`<i style="left:0;top:${y}px;width:${W}px;height:1px"></i>`,
              `<u style="left:3px;top:${y + 3}px">${y}</u>`);

  const mPerPx = ((bb.e - bb.w) * mLon) / W;
  await page.setContent(`
    <style>
      body{margin:0;background:#0b0b0c;font:13px -apple-system,sans-serif;color:#fff}
      .sky{position:relative;width:${W}px;height:${H}px}
      .sky img{display:block;width:${W}px;height:${H}px}
      .sky i{position:absolute;background:rgba(255,255,255,.22)}
      .sky u{position:absolute;font-size:9px;text-decoration:none;text-shadow:0 0 3px #000,0 0 3px #000}
      .hd{position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.78);
          padding:4px 8px;border-radius:6px;font-size:11px;font-weight:600}
    </style>
    <div class="sky">
      <img src="data:image/png;base64,${sky}">${grid.join("")}
      <div class="hd">${b.name} (${b.code}) · 1px ≈ ${mPerPx.toFixed(3)}m · 격자 100px ≈ ${(mPerPx * 100).toFixed(0)}m · 위가 북쪽</div>
    </div>
  `);
  await page.waitForTimeout(200);
  await page.locator(".sky").screenshot({ path: `${OUT}/${b.code}-sky.png` });

  if (shots.length) {
    await page.setContent(`
      <style>
        body{margin:0;background:#0b0b0c;font:13px -apple-system,sans-serif;color:#fff;
             display:grid;grid-template-columns:${RW}px ${RW}px;gap:3px;width:max-content}
        .rv{position:relative;width:${RW}px;height:${RH}px;background:#1a1a1c}
        .rv img{display:block;width:${RW}px;height:${RH}px}
        .rv b{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.78);
              padding:3px 7px;border-radius:6px;font-size:11px}
      </style>
      ${shots.map((s, i) => `<div class="rv"><img src="data:image/png;base64,${s}"><b>${b.name} 로드뷰 ${i + 1} — 지도의 파란 ${i + 1}번에서</b></div>`).join("")}
    `);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${b.code}-rv.png`, fullPage: true });
  }

  meta[b.code] = { name: b.name, bounds: bb, w: W, h: H,
                   mPerPx: Number(mPerPx.toFixed(4)), roadviews: shots.length };
  writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));
  console.log(`로드뷰 ${shots.length}장`);

  await boot();   // 다음 건물을 위해 지도 문서를 되돌린다
}

await browser.close();
console.log(`\n→ ${OUT}`);
