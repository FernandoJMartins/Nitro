import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Em dev dentro do Docker, o backend é acessível pelo nome do serviço ("backend").
// Rodando local (npm run dev), cai no default localhost:8000.
const proxyTarget = process.env.VITE_PROXY_TARGET || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // escuta em 0.0.0.0 (necessário dentro do container)
    port: 5173,
    // No Windows + bind mount do Docker os eventos de arquivo não chegam;
    // polling garante que o hot-reload funcione.
    watch: { usePolling: true, interval: 200 },
    proxy: {
      "/api": proxyTarget,
      "/health": proxyTarget,
    },
  },
});
