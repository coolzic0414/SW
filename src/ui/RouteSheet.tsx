/** 카카오 버전과 MapLibre 버전이 같이 쓰는 시트·단계목록·구성막대. */
import { useRef, useState } from "react";
import {
  CornerUpLeft, CornerUpRight, ArrowUp, DoorOpen, Building2, Flag, Circle,
} from "lucide-react";
import { formatDuration, type CampusRoute } from "../lib/campus.ts";
import type { Step, StepKind } from "../lib/steps.ts";

/**
 * 시트 높이 단계.
 * 기본은 맨 아래다 — 지도가 주인공이고 시트는 답만 보여준다.
 * 접힌 상태에서도 "어디로, 몇 분"은 읽히도록 높이를 잡았다.
 */
export const SNAPS = [0.16, 0.5, 0.86] as const;

export function Sheet({ snap, setSnap, children }: {
  snap: number; setSnap: (i: number) => void; children: React.ReactNode;
}) {
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const height = live ?? SNAPS[snap] * window.innerHeight;

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: SNAPS[snap] * window.innerHeight, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dy) > 4) drag.current.moved = true;
    setLive(Math.max(90, Math.min(window.innerHeight * 0.9, drag.current.h - dy)));
  };
  const onUp = () => {
    const moved = drag.current?.moved ?? false;
    if (moved && live !== null) {
      const r = live / window.innerHeight;
      let best = 0;
      SNAPS.forEach((s, i) => { if (Math.abs(s - r) < Math.abs(SNAPS[best] - r)) best = i; });
      setSnap(best);
    }
    drag.current = null;
    setLive(null);
    // 끌었으면 이어서 오는 click 은 무시한다. 안 그러면 높이가 두 번 바뀐다.
    if (moved) suppressClick.current = true;
  };

  // 끌고 놓을 때 pointerup 뒤에 click 이 한 번 더 온다
  const suppressClick = useRef(false);
  const onClick = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    setSnap(snap >= SNAPS.length - 1 ? 0 : snap + 1);
  };

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-3xl border-t bg-card shadow-[0_-4px_40px_rgb(0_0_0/0.12)]"
      style={{ height, transition: live === null ? "height .28s cubic-bezier(.32,.72,0,1)" : "none" }}
    >
      <div
        className="shrink-0 cursor-grab touch-none px-5 pt-2.5 pb-1 active:cursor-grabbing"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
        role="button" tabIndex={0}
        aria-label={`시트 높이 조절 (현재 ${snap + 1}/${SNAPS.length} 단계)`}
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}

const STEP_ICON: Record<StepKind, React.ReactNode> = {
  start: <Circle className="size-3.5 fill-current" />,
  straight: <ArrowUp className="size-4" />,
  left: <CornerUpLeft className="size-4" />,
  right: <CornerUpRight className="size-4" />,
  through: <Building2 className="size-4" />,
  approach: <DoorOpen className="size-4" />,
  arrive: <Flag className="size-4" />,
};

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="mt-5 border-t pt-4">
      {steps.map((s, i) => {
        const accent = s.kind === "through";
        const edge = s.kind === "start" || s.kind === "arrive";
        return (
          <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && (
              <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border" aria-hidden />
            )}
            <span
              className={`relative z-[1] grid size-7 shrink-0 place-items-center rounded-full border
                ${accent ? "border-accent bg-accent text-accent-foreground"
                         : edge ? "border-foreground bg-foreground text-background"
                                : "border-border bg-muted text-muted-foreground"}`}
            >
              {STEP_ICON[s.kind]}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className={`text-sm ${edge || accent ? "font-semibold" : "font-medium"}`}>{s.text}</p>
              {s.meters > 0 && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {s.meters}m · {formatDuration(s.seconds)}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** 길 종류별 비중을 한 줄로. 범례를 따로 두는 것보다 뜻과 양을 같이 읽는다. */
export function Composition({ route }: { route: CampusRoute }) {
  const parts = [
    { key: "through", label: "건물 관통", cls: "bg-accent" },
    { key: "path", label: "바깥 길", cls: "bg-primary" },
    { key: "approach", label: "접근로", cls: "bg-muted-foreground/40" },
  ] as const;

  const sec: Record<string, number> = { through: 0, path: 0, approach: 0 };
  for (const e of route.edges) {
    const k = e.kind === "through_building" ? "through" : e.kind === "approach" ? "approach" : "path";
    sec[k] += e.seconds;
  }
  const total = Math.max(route.seconds, 1);
  const shown = parts.filter((p) => sec[p.key] > 0);

  return (
    <div className="mt-3">
      <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {shown.map((p) => (
          <div key={p.key} className={p.cls} style={{ width: `${(sec[p.key] / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted-foreground">
        {shown.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <i className={`size-1.5 rounded-full ${p.cls}`} />
            {p.label} {formatDuration(Math.round(sec[p.key]))}
          </span>
        ))}
        {route.hasUnverified && <span className="text-accent">· 미확인 구간 포함</span>}
      </div>
    </div>
  );
}
