import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "iis-client"),
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "Signal.Server", "wwwroot"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5168",
        changeOrigin: false,
      },
    },
  },
});
