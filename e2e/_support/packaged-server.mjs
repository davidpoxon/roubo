// The server of the packaged app, started for the packaged run of the reload
// suite (HR-TC-053, E2E_RUN_MODE=packaged in playwright.config.ts).
//
// It runs under the packaged app's own executable with ELECTRON_RUN_AS_NODE=1,
// so the server is the bundle the app ships (inside app.asar), on the
// Electron runtime and with the native modules the app was packaged with. It
// sets ROUBO_PRODUCTION as the app's bootstrap does, so the state dir is
// ~/.roubo: the workflow gives the run a throwaway HOME, and ROUBO_E2E_PACKAGED
// lets the e2e harness use that state (server/lib/e2e-state-guard.ts).
//
// The window is not opened: the suite drives the served client in Chromium,
// as every other run of the suite does.
//
// Usage: ELECTRON_RUN_AS_NODE=1 <app executable> e2e/_support/packaged-server.mjs <server entry>
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (!entry) {
  console.error("packaged-server: pass the packaged server entry (resources/server/dist/index.js)");
  process.exit(2);
}
const port = Number(process.env.ROUBO_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("packaged-server: ROUBO_PORT must name the port to serve on");
  process.exit(2);
}

process.env.ROUBO_PRODUCTION = "1";
const { startServer, installAppLogging } = await import(pathToFileURL(entry).href);
installAppLogging();
const handle = await startServer({ port });
console.log(`packaged-server: listening on ${handle.port}`);

const stop = async () => {
  try {
    await handle.shutdown();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
