import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// 화면 스위치.
//   /       → 카카오맵 길찾기 (기본)
//   /?gl    → MapLibre + OpenFreeMap (지도 스타일 직접 정의, 건물 3D)   — 개발 중에만
//   /?edit  → 출입구 찍는 도구                                         — 개발 중에만
//
// 편집 도구·실험용 지도는 배포본에 넣지 않는다. 누구나 ?edit 로 열 수 있게 되고,
// MapLibre 때문에 배포 파일이 2MB 넘게 커진다. import.meta.env.DEV 가 false 면
// 아래 동적 import 는 빌드에서 통째로 빠진다.
const q = new URLSearchParams(location.search);
const DevTool = import.meta.env.DEV
  ? q.has("edit") ? lazy(() => import("./DoorEditor.tsx"))
  : q.has("gl") ? lazy(() => import("./AppGL.tsx"))
  : null
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {DevTool ? <Suspense fallback={null}><DevTool /></Suspense> : <App />}
  </StrictMode>,
);
