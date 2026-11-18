import { useEffect, useRef, useState } from "react";

const SDK_ID = "kakao-maps-sdk";

/** 카카오맵 SDK를 한 번만 불러온다. autoload=false 로 받고 명시적으로 load 한다. */
function loadSdk(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.kakao?.maps?.Map) return resolve();

    const done = () => window.kakao.maps.load(() => resolve());
    const existing = document.getElementById(SDK_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", () => reject(new Error("SDK 로드 실패")));
      return;
    }
    const s = document.createElement("script");
    s.id = SDK_ID;
    s.async = true;
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false`;
    s.onload = done;
    s.onerror = () =>
      reject(new Error("SDK 로드 실패 — 키가 맞는지, 카카오 개발자센터 플랫폼에 이 주소가 등록됐는지 확인"));
    document.head.appendChild(s);
  });
}

export interface MapState {
  ref: React.RefObject<HTMLDivElement | null>;
  map: any | null;
  error: string | null;
}

export function useKakaoMap(center: [number, number], level = 3): MapState {
  const ref = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = import.meta.env.VITE_KAKAO_JS_KEY;
    if (!key) {
      setError("VITE_KAKAO_JS_KEY 가 없습니다. .env 파일에 카카오 JavaScript 키를 넣어주세요.");
      return;
    }
    let cancelled = false;
    loadSdk(key)
      .then(() => {
        if (cancelled || !ref.current) return;
        const { kakao } = window;
        const m = new kakao.maps.Map(ref.current, {
          center: new kakao.maps.LatLng(center[0], center[1]),
          level,
        });
        // 개발 중에만 콘솔·자동화 스크립트에서 지도를 만질 수 있게 열어둔다
        if (import.meta.env.DEV) (window as unknown as { __map?: unknown }).__map = m;
        setMap(m);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
    // center/level 은 최초 1회만 쓴다. 이후 이동은 map 객체로 직접 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ref, map, error };
}
