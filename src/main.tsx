import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import AppApex from "./apex/AppApex.tsx";
import "./index.css";

// 화면 스위치.
//   /         → 3D 지도(MapLibre) 길찾기 (기본)
//   /?kakao   → 카카오 2D 지도 길찾기 (이전 기본)
//   /?gl      → MapLibre + OpenFreeMap 실험 지도                     — 개발 중에만
//   /?edit    → 출입구 찍는 도구                                     — 개발 중에만
//
// 편집 도구·실험용 지도는 배포본에 넣지 않는다. 누구나 ?edit 로 열 수 있게 된다.
// import.meta.env.DEV 가 false 면 아래 동적 import 는 빌드에서 통째로 빠진다.
const q = new URLSearchParams(location.search);
const DevTool = import.meta.env.DEV
  ? q.has("edit") ? lazy(() => import("./DoorEditor.tsx"))
  : q.has("gl") ? lazy(() => import("./AppGL.tsx"))
  : null
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {DevTool ? <Suspense fallback={null}><DevTool /></Suspense> : q.has("kakao") ? <App /> : <AppApex />}
  </StrictMode>,
);
