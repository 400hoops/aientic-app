import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = process.env.AIENTIC_API_ORIGIN || "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,        // reachable from other devices on the LAN
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
