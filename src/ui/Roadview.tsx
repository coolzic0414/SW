/**
 * 목적지 건물의 로드뷰 미리보기.
 *
 * 글로 "공학관 동쪽 출입구"라고 적는 것보다 실제 사진 한 장이 정확하다.
 * 그리고 이건 카카오만 가진 자산이다 — MapLibre 로는 못 한다.
 */
import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";

export function Roadview({ at, label }: { at: [number, number] | null; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");

  useEffect(() => {
    const kakao = (window as any).kakao;
    if (!at || !box.current || !kakao?.maps?.Roadview) return;

    setState("loading");
    const el = box.current;
    const pos = new kakao.maps.LatLng(at[0], at[1]);
    const client = new kakao.maps.RoadviewClient();
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // 촬영 지점 후보 — 건물 한가운데에서 가장 가까운 곳, 그다음 건물 둘레 사방(약 35m 밖).
    // 가장 가까운 한 곳만 쓰면 안 된다: 카카오가 돌려주는 지점 중에 사진 파일이 서버에 없는(404) 것이 있다
    // (교직원식당 앞 2026년 5월 촬영분). 그런 지점은 화면이 회색으로 비고 init 이 끝내 오지 않는다.
    const OFFS: [number, number][] = [[0, 0], [3e-4, 0], [-3e-4, 0], [0, 4e-4], [0, -4e-4],
                                      [3e-4, 4e-4], [-3e-4, -4e-4], [3e-4, -4e-4], [-3e-4, 4e-4]];
    const nearest = (la: number, lo: number, r: number) => new Promise<number | null>((ok) => {
      timers.push(setTimeout(() => ok(null), 3000));   // 촬영이 없는 곳은 콜백이 안 돌아오기도 한다
      client.getNearestPanoId(new kakao.maps.LatLng(la, lo), r, ok);
    });

    /** 새 로드뷰를 띄워 init 이 오면 성공. 깨진 지점이 남긴 화면이 섞이지 않게 매번 새로 만든다. */
    const tryPano = (panoId: number) => new Promise<boolean>((ok) => {
      el.replaceChildren();
      const holder = document.createElement("div");
      holder.style.cssText = "width:100%;height:100%";
      el.appendChild(holder);
      const view = new kakao.maps.Roadview(holder);
      timers.push(setTimeout(() => ok(false), 4000));
      kakao.maps.event.addListener(view, "init", () => {
        // 촬영 지점에서 건물 쪽을 바라보게 각도를 돌린다
        const from = view.getPosition();
        const dy = at[0] - from.getLat();
        const dx = (at[1] - from.getLng()) * Math.cos((at[0] * Math.PI) / 180);
        const pan = (Math.atan2(dx, dy) * 180) / Math.PI;
        view.setViewpoint({ pan: (pan + 360) % 360, tilt: 0, zoom: 0 });
        ok(true);
      });
      view.setPanoId(panoId, pos);
    });

    (async () => {
      const tried = new Set<number>();
      for (const [i, [dy, dx]] of OFFS.entries()) {
        const id = await nearest(at[0] + dy, at[1] + dx, i === 0 ? 80 : 60);
        if (cancelled) return;
        if (!id || tried.has(id)) continue;
        tried.add(id);
        const shown = await tryPano(id);
        if (cancelled) return;
        if (shown) { setState("ok"); return; }
      }
      el.replaceChildren();
      setState("none");
    })();

    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [at?.[0], at?.[1]]);

  if (!at) return null;

  return (
    <div className="mt-4">
      <div className="relative h-40 overflow-hidden rounded-2xl bg-card">
        <div ref={box} className="h-full w-full" />
        {state !== "ok" && (
          <div className="absolute inset-0 grid place-items-center gap-1 text-center">
            <Camera className="mx-auto size-5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {state === "loading" ? "로드뷰 불러오는 중" : "이 건물은 로드뷰가 없습니다"}
            </p>
          </div>
        )}
        {state === "ok" && label && (
          <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-full bg-black/55 px-2.5 py-1 text-[12px] font-medium text-white backdrop-blur">
            {label} 앞
          </span>
        )}
      </div>
    </div>
  );
}
