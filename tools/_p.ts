import { readFileSync } from "node:fs";
import { findRoute } from "../src/lib/graph.ts";
const g: any = JSON.parse(readFileSync(process.argv[2] ?? "data/outdoor-graph.json", "utf-8"));
const snap = new Map<string,string>(g.building_snap.map((s: any) => [s.code, s.node]));
for (const [a, b] of [["@향설생활관2","H"],["@향설생활관2","M"],["H","@향설생활관2"],["M","@향설생활관2"],["@향설생활관3","H"],["@글로벌빌리지","H"],["RC","M"]]) {
  const r: any = findRoute(g, snap.get(a)!, snap.get(b)!);
  console.log(a, "→", b, Math.round(r.meters)+"m", Math.round(r.seconds)+"s", [...new Set(r.edges.map((e: any) => e.name).filter(Boolean))].join(" · "));
}
