import { chromium } from "playwright";
const S = process.env.S;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 880 }, deviceScaleFactor: 2 });

const logs = [];
p.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const failed = [];
p.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText}  ${r.url().slice(0, 90)}`));

await p.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 30000 });
await p.waitForTimeout(3500);

const errBox = await p.locator(".map-error").count();
const mapChildren = await p.locator(".map > *").count();
const tiles = await p.locator('.map img').count();
const verdict = await p.locator(".verdict").first().innerText().catch(() => "(없음)");
const headline = await p.locator(".headline").first().innerText().catch(() => "(경로 없음)");
const pins = await p.locator(".pin").count();

console.log("map-error 박스:", errBox ? "있음 ❌" : "없음 ✅");
console.log("map 자식 노드:", mapChildren, "| 타일 img:", tiles, "| 건물 핀:", pins);
console.log("판정문:", verdict.replace(/\n/g, " "));
console.log("요약:", headline.replace(/\n/g, " "));
if (errBox) console.log("에러문구:", (await p.locator(".map-error").innerText()).replace(/\n/g, " "));
console.log("\n--- console ---"); logs.slice(0, 15).forEach((l) => console.log(" ", l));
console.log("--- failed requests ---"); failed.slice(0, 8).forEach((l) => console.log(" ", l));

await p.screenshot({ path: `${S}/app.png`, fullPage: false });
await b.close();
