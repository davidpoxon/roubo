import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const port = parseInt(process.env.DEV_PORT || "3334", 10);
const apiPort = parseInt(process.env.DEV_API_PORT || "3335", 10);

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        configure: (proxy) => {
          setImmediate(() => {
            proxy.removeAllListeners("error");
            proxy.on("error", () => {
              console.warn(
                "[proxy] Server not ready — /api request failed, will retry when server starts",
              );
            });
          });
        },
      },
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
        configure: (proxy) => {
          setImmediate(() => {
            proxy.removeAllListeners("error");
            proxy.removeAllListeners("proxyReqWs");
            proxy.on("error", () => {
              console.warn("[proxy] Server not ready — WebSocket will reconnect automatically");
            });
            proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
              socket.on("error", () => {});
            });
          });
        },
      },
    },
  },
});
