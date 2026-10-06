import type { ServerHandle } from "../../server/dist/index.js";

export type ServerHandleLike = Pick<ServerHandle, "port" | "shutdown">;

export interface BootstrapDeps {
  env: NodeJS.ProcessEnv;
  importServer: () => Promise<{
    startServer: (opts: { port: number }) => Promise<ServerHandleLike>;
    installAppLogging: () => void;
  }>;
}

export interface BootstrapResult {
  url: string;
  serverHandle: ServerHandleLike | null;
}

export async function resolveBootstrap(deps: BootstrapDeps): Promise<BootstrapResult> {
  if (deps.env.ROUBO_DEV === "1") {
    return { url: "http://localhost:3334", serverHandle: null };
  }

  deps.env.ROUBO_PRODUCTION = "1";
  const { startServer, installAppLogging } = await deps.importServer();
  // Installed as soon as the server module has loaded and before startServer
  // can throw, so a startServer failure (main.ts's own catch logs "bootstrap
  // failed") lands in the log file too: installAppLogging patches the global
  // console object, so main.ts's later console.error call is teed
  // automatically. A failure to import the server module itself happens before
  // this line and is not logged to the file (AP-NFR-003-adjacent, TODO: cite
  // tracking issue once filed).
  installAppLogging();
  const handle = await startServer({ port: 0 });
  return { url: `http://127.0.0.1:${handle.port}`, serverHandle: handle };
}
