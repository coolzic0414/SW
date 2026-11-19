/** 기본 화면: 같은 앱에 3D 지도(MapLibre) 부품만 끼운 것. 카카오 2D 는 /?kakao */
import App from "../App.tsx";
import { APEX_KIT } from "./kit.tsx";

export default function AppApex() {
  return <App kit={APEX_KIT} />;
}
