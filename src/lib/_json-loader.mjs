// 테스트 전용: Node 가 data/*.json 을 import 할 수 있게 해 준다 (Vite 는 알아서 한다).
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL(url), "utf8");
    return { format: "module", source: `export default ${src};`, shortCircuit: true };
  }
  return next(url, ctx);
}
