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
  // Installed as soon as the server module is available and before startServer
  // can throw, so a failed boot (main.ts's own catch logs "bootstrap failed")
  // lands in the log file too: installAppLogging patches the global console
  // object, so main.ts's later console.error call is teed automatically, with
  // no separate try/catch needed here (AP-NFR-003-adjacent, TODO: cite tracking
  // issue once filed).
  installAppLogging();
  const handle = await startServer({ port: 0 });
  return { url: `http://127.0.0.1:${handle.port}`, serverHandle: handle };
}
