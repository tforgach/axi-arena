import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// UI lives in ui/, builds to dist/ (served by src/server.ts). `npm run dev:web` proxies the API
// to a running `axi-arena serve`.
export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4477" } },
});
