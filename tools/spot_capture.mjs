/**
 * 지점 확대 조사: 위경도 지점마다 스카이뷰를 가장 크게(레벨 1, 화면 배율 2) 찍고,
 * 가장 가까운 로드뷰에서 그 지점을 정면으로 본 사진을 옆에 붙인다.
 * 출입구·계단처럼 작은 것을 확인할 때 쓴다. 지점은 JSON 파일로 받는다: [[이름, lat, lon], ...]
 *
 *   node tools/spot_capture.mjs tmp/spots.json
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
const OUT = `${process.env.OUT_DIR ?? "tmp"}/spots`;
mkdirSync(OUT, { recursive: true });
const KEY = readFileSync(".env", "utf8").match(/VITE_KAKAO_JS_KEY=(\S+)/)[1];
const spots = JSON.parse(readFileSync(process.argv[2], "utf8"));
const S = 420, RW = 520, RH = 420;
const br = await chromium.launch();
const p = await br.newPage({ viewport: { width: S + RW + 30, height: Math.max(S, RH) + 20 }, deviceScaleFactor: 2 });
p.on("pageerror", (e) => console.log("  페이지 오류:", String(e).slice(0, 160)));
// 앱 페이지에서 시작하면 개발 서버 새로고침이 촬영 문서를 덮어쓴다. 같은 출처(카카오 키 허용 주소)의 정적 파일에서 시작한다.
// 카카오 키는 localhost:5173 에만 열려 있어 그 출처의 빈 문서가 필요하다. 앱 주소로 가면 개발 서버 새로고침이
// 촬영 문서를 덮어쓰고, 없는 주소는 index.html 로 넘어가 앱이 뜬다. 그래서 빈 문서를 직접 돌려준다.
await p.route("http://localhost:5173/__spot", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
await p.goto("http://localhost:5173/__spot");
await p.setContent(`<style>body{margin:0;background:#111;display:flex;gap:6px;padding:6px;font:12px -apple-system,sans-serif;color:#fff}
  #sky{width:${S}px;height:${S}px;position:relative} #rv{width:${RW}px;height:${RH}px;position:relative}
  .x{position:absolute;left:210px;top:210px;width:26px;height:26px;margin:-13px 0 0 -13px;border:2px solid #ff3b30;border-radius:50%;z-index:9;pointer-events:none;box-shadow:0 0 0 1px #000}
  .t{position:absolute;left:6px;top:6px;z-index:9;background:rgba(0,0,0,.75);padding:3px 7px;border-radius:6px;font-weight:600}</style>
  <!-- 카카오가 지도·로드뷰 상자 안을 통째로 갈아엎으므로 이름표는 상자 바깥(감싼 div)에 둔다 -->
  <div style="position:relative"><div id="sky"></div><div class="x"></div><div class="t" id="t1"></div></div>
  <div style="position:relative"><div id="rv"></div><div class="t" id="t2"></div></div>
  <script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>`);
await p.waitForFunction(() => window.kakao?.maps?.load);
await p.evaluate(() => new Promise((r) => window.kakao.maps.load(r)));
await p.evaluate(() => {
  const { kakao } = window;
  window.M = new kakao.maps.Map(document.getElementById("sky"), { center: new kakao.maps.LatLng(36.77, 126.93), level: 1 });
  window.M.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
  window.RV = new kakao.maps.Roadview(document.getElementById("rv"));
  window.RVC = new kakao.maps.RoadviewClient();
  window.ready = null;
  const fire = () => { const f = window.ready; window.ready = null; if (f) f(); };
  kakao.maps.event.addListener(window.RV, "init", fire);
  kakao.maps.event.addListener(window.RV, "panoid_changed", fire);
});
for (const [name, lat, lon] of spots) {
  const info = await Promise.race([new Promise((r) => setTimeout(() => r(null), 15000)), p.evaluate(([lat, lon, name]) => new Promise((res) => {
    const { kakao } = window;
    window.M.setCenter(new kakao.maps.LatLng(lat, lon));
    document.getElementById("t1").textContent = `${name} · 스카이뷰 (가운데 빨간 원)`;
    // 촬영 지점이 없으면 카카오가 콜백을 아예 안 부르는 경우가 있다. 4초 기다리다 없음으로 본다.
    const none = setTimeout(() => { document.getElementById("t2").textContent = "60m 안에 로드뷰 없음"; res(null); }, 4000);
    window.RVC.getNearestPanoId(new kakao.maps.LatLng(lat, lon), 60, (id) => {
      clearTimeout(none);
      if (!id) { document.getElementById("t2").textContent = "60m 안에 로드뷰 없음"; return res(null); }
      const t = setTimeout(() => { window.ready = null; res(null); }, 7000);
      window.ready = () => {
        clearTimeout(t);
        setTimeout(() => {
          const f = window.RV.getPosition();
          const dy = lat - f.getLat(), dx = (lon - f.getLng()) * Math.cos(lat * Math.PI / 180);
          const pan = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
          const dist = Math.hypot(dy * 111320, dx * 111320);
          window.RV.setViewpoint({ pan, tilt: -4, zoom: dist > 30 ? 2 : 0 });
          document.getElementById("t2").textContent = `로드뷰 · ${dist.toFixed(0)}m 떨어진 곳에서 이 지점 방향(${pan.toFixed(0)}°)`;
          res({ dist: Math.round(dist), pan: Math.round(pan) });
        }, 200);
      };
      window.RV.setPanoId(id, new kakao.maps.LatLng(lat, lon));
    });
  }), [lat, lon, name])]);   // 무슨 일이 있어도 15초 넘게 붙잡지 않는다
  await p.waitForTimeout(2200);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, info ? `로드뷰 ${info.dist}m` : "로드뷰 없음");
}
await br.close();
