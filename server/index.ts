import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type * as http from "node:http";

import { WebSocketServer } from "ws";
import { loadEnvFile, resolveShellPath, resolveClaudeBinary } from "./services/env.js";
import { checkForUpdate } from "./services/version-check.js";
import { detectClaudeAutoMode } from "./services/claude-version.js";
import * as projectRegistry from "./services/project-registry.js";
import * as benchManager from "./services/bench-manager.js";
import * as processManager from "./services/process-manager.js";
import * as databaseService from "./services/database.js";
import * as terminalService from "./services/terminal.js";
import projectsRouter from "./routes/projects.js";
import benchesRouter from "./routes/benches.js";
import containersRouter from "./routes/containers.js";
import filesystemRouter from "./routes/filesystem.js";
import databaseRouter from "./routes/database.js";
import terminalRouter from "./routes/terminal.js";
import inspectionRouter from "./routes/inspection.js";
import issuesRouter from "./routes/issues.js";
import settingsRouter from "./routes/settings.js";
import blueprintsRouter from "./routes/blueprints.js";
import appBlueprintsRouter from "./routes/app-blueprints.js";
import permissionsRouter from "./routes/permissions.js";
import projectSettingsRouter from "./routes/project-settings.js";
import benchesSettingsRouter from "./routes/benches-settings.js";
import authRouter from "./routes/auth.js";
import hooksRouter from "./routes/hooks.js";
import notificationsRouter from "./routes/notifications.js";
import * as blueprintManager from "./services/blueprint-manager.js";
import * as autoClear from "./services/auto-clear.js";
import * as pluginManager from "./services/plugin-manager.js";
import { resolveClientDist } from "./clientDist.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface StartOptions {
  port?: number;
}

export interface ServerHandle {
  server: http.Server;
  port: number;
  shutdown: () => Promise<void>;
}

let envInitialized = false;
// Snapshot the externally-supplied ROUBO_PORT once, taken AFTER loadEnvFile()
// has had a chance to populate process.env from $ROUBO_DIR/.env, but BEFORE
// startServer ever publishes the bound port back into process.env. Without
// this snapshot, a second startServer() call with no options would re-use the
// previously-bound port instead of falling back to the default 3335.
let initialEnvPort: string | undefined;

export async function startServer(options: StartOptions = {}): Promise<ServerHandle> {
  if (!envInitialized) {
    loadEnvFile();
    resolveShellPath();
    resolveClaudeBinary();
    initialEnvPort = process.env.ROUBO_PORT;
    envInitialized = true;
  }

  const requestedPort = options.port ?? parseInt(initialEnvPort || "3335", 10);
  if (isNaN(requestedPort)) {
    throw new Error(`Invalid port: ${options.port ?? initialEnvPort}`);
  }

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "210kb" }));

  app.use("/api/projects", projectsRouter);
  app.use("/api/projects", benchesRouter);
  app.use("/api/projects", databaseRouter);
  app.use("/api/projects", terminalRouter);
  app.use("/api/projects", inspectionRouter);
  app.use("/api/projects", issuesRouter);
  app.use("/api/projects", blueprintsRouter);
  app.use("/api/projects", permissionsRouter);
  app.use("/api/projects", projectSettingsRouter);
  app.use("/api/projects", benchesSettingsRouter);
  app.use("/api/blueprints", appBlueprintsRouter);
  app.use("/api/containers", containersRouter);
  app.use("/api/filesystem/browse", filesystemRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/auth/github", authRouter);
  app.use("/api/hooks", hooksRouter);
  app.use("/api/notifications", notificationsRouter);

  app.get("/api/benches", (req, res) => {
    let benches = benchManager.getBenches();
    const issue = parseInt(req.query.issue as string, 10);
    if (!isNaN(issue)) {
      benches = benches.filter((b) => b.assignedIssue?.number === issue);
    }
    res.json(benches);
  });

  const clientDist = resolveClientDist(__dirname);
  app.use(express.static(clientDist));
  app.get("/{*path}", (_req, res, next) => {
    if (_req.path.startsWith("/api")) return next();
    res.sendFile(path.join(clientDist, "index.html"), (err) => {
      if (err) next();
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  let server: http.Server;
  try {
    server = await new Promise<http.Server>((resolve, reject) => {
      const s = app.listen(requestedPort, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
  } catch (err) {
    wss.close();
    throw err;
  }

  const boundPort = (server.address() as AddressInfo).port;
  // Publish the actually-bound port so downstream code (e.g. the Claude Code
  // notification hook URL written into each bench's .claude/settings.local.json)
  // resolves to a port that's actually listening, even when the server was
  // started with port: 0 (Electron production build).
  process.env.ROUBO_PORT = String(boundPort);
  console.log(`Roubo running on http://127.0.0.1:${boundPort}`);

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/terminal\/(.+)$/);

    if (match) {
      const sessionId = match[1];
      if (!terminalService.hasSession(sessionId)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        terminalService.handleWebSocket(sessionId, ws);
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  console.log("Initializing project registry...");
  projectRegistry.initialize();

  console.log("Initializing plugin manager...");
  try {
    await pluginManager.initialize();
  } catch (err) {
    console.error("Plugin manager initialization failed:", (err as Error).message);
  }

  console.log("Initializing bench manager...");
  benchManager.initialize();

  console.log("Reconciling state with system...");
  await benchManager.reconcile();

  console.log("Loading persisted terminal sessions...");
  terminalService.loadPersistedSessions();

  console.log("Starting blueprint watchers...");
  blueprintManager.startAppBlueprintsWatcher();
  for (const project of projectRegistry.getProjects()) {
    blueprintManager.startWatchers(project.id, project.repoPath);
  }

  const statusInterval = setInterval(() => {
    benchManager.refreshComponentStatuses().catch(console.error);
  }, 5000);

  console.log("Starting auto-clear watcher...");
  autoClear.start();

  const idleDbInterval = setInterval(() => {
    databaseService.closeIdleConnections().catch(console.error);
  }, 60_000);

  if (!process.env.ROUBO_QUIET && process.env.ROUBO_VERSION) {
    void checkForUpdate(process.env.ROUBO_VERSION);
  }

  void detectClaudeAutoMode();

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    clearInterval(statusInterval);
    clearInterval(idleDbInterval);
    autoClear.stop();
    blueprintManager.stopAllWatchers();
    terminalService.destroyAllSessions();
    await new Promise<void>((r) => wss.close(() => r()));
    await databaseService.closeAllConnections();
    await pluginManager.shutdown();
    await processManager.stopAllProcesses();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { server, port: boundPort, shutdown };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const handle = await startServer();
  const onSignal = async () => {
    console.log("\nShutting down...");
    try {
      await handle.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
