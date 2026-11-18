import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // 포트 고정: 카카오 개발자센터의 JavaScript SDK 도메인에 http://localhost:5173 이
  // 등록돼 있다. 포트가 바뀌면 지도 SDK가 401(domain mismatched)로 막힌다.
  server: { host: true, port: 5173, strictPort: true },
});
