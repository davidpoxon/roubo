import type { ServerHandle } from "../../server/dist/index.js";

export type ServerHandleLike = Pick<ServerHandle, "port" | "shutdown">;

export interface BootstrapDeps {
  env: NodeJS.ProcessEnv;
  importServer: () => Promise<{
    startServer: (opts: { port: number }) => Promise<ServerHandleLike>;
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
  const { startServer } = await deps.importServer();
  const handle = await startServer({ port: 0 });
  return { url: `http://127.0.0.1:${handle.port}`, serverHandle: handle };
}
