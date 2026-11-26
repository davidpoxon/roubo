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
                "[proxy] Server not ready: /api request failed, will retry when server starts",
              );
            });
          });
        },
      },
      // The ROUBO_E2E=1-only harness routes, for the dev-mode run of the e2e
      // reload suite (E2E_RUN_MODE=dev in playwright.config.ts). A server
      // without ROUBO_E2E answers them 404. A key that starts with ^ is a
      // pattern, so a client route such as /testbench is not proxied.
      "^/test/__": {
        target: `http://localhost:${apiPort}`,
      },
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
        configure: (proxy) => {
          setImmediate(() => {
            proxy.removeAllListeners("error");
            proxy.removeAllListeners("proxyReqWs");
            proxy.on("error", () => {
              console.warn("[proxy] Server not ready: WebSocket will reconnect automatically");
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
