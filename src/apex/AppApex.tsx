/** 시험작: 지금 앱에 3D 지도 부품만 끼운 것. 개발 서버에서 /?apex 로만 열린다. 배포본에는 안 들어간다. */
import App from "../App.tsx";
import { APEX_KIT } from "./kit.tsx";

export default function AppApex() {
  return <App kit={APEX_KIT} />;
}
