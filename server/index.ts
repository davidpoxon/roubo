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
import { initializeIntegrationMigrations } from "./services/integration-migrations.js";
import * as benchManager from "./services/bench-manager.js";
import { isAlertExternalId } from "./services/alert-external-id.js";
import * as processManager from "./services/process-manager.js";
import * as terminalService from "./services/terminal.js";
import projectsRouter from "./routes/projects.js";
import benchesRouter from "./routes/benches.js";
import containersRouter from "./routes/containers.js";
import filesystemRouter from "./routes/filesystem.js";
import terminalRouter from "./routes/terminal.js";
import inspectionRouter from "./routes/inspection.js";
import testbenchRouter from "./routes/testbench.js";
import gatesRouter from "./routes/gates.js";
import issuesRouter from "./routes/issues.js";
import settingsRouter from "./routes/settings.js";
import jigsRouter from "./routes/jigs.js";
import appJigsRouter from "./routes/app-jigs.js";
import permissionsRouter from "./routes/permissions.js";
import projectSettingsRouter from "./routes/project-settings.js";
import benchesSettingsRouter from "./routes/benches-settings.js";
import pluginsGithubOauthRouter from "./routes/plugins-github-oauth.js";
import hooksRouter from "./routes/hooks.js";
import notificationsRouter from "./routes/notifications.js";
import integrationRouter from "./routes/integration.js";
import pluginsRouter from "./routes/plugins.js";
import marketplaceRouter from "./routes/marketplace.js";
import migrationRouter from "./routes/migration.js";
import testRouter from "./routes/test.js";
import * as jigManager from "./services/jig-manager.js";
import * as pluginManager from "./services/plugin-manager.js";
import * as catalogClient from "./services/catalog-client.js";
import * as githubService from "./services/github.js";
import * as migrate from "./services/migrate.js";
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

  // Contradictory flags fail fast, before any state-touching work (issue #877).
  // ROUBO_E2E=1 means the test harness owns this process, but ROUBO_PRODUCTION
  // makes resolveRouboDir() point at the real ~/.roubo, which boot would then
  // mutate (migrate.run() writes state.json even on the no-op path). This
  // combination arises when the harness is launched from a bench terminal that
  // inherited the app's env; refusing here beats a half-working harness.
  if (process.env.ROUBO_E2E === "1" && process.env.ROUBO_PRODUCTION) {
    throw new Error(
      "Refusing to start: ROUBO_E2E=1 and ROUBO_PRODUCTION are both set, so the e2e harness would run against the production ~/.roubo state. Unset ROUBO_PRODUCTION (bench terminals inherit it from the app; see issue #877).",
    );
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
  app.use("/api/projects", terminalRouter);
  app.use("/api/projects", inspectionRouter);
  app.use("/api/projects", testbenchRouter);
  app.use("/api/projects", gatesRouter);
  app.use("/api/projects", issuesRouter);
  app.use("/api/projects", jigsRouter);
  app.use("/api/projects", permissionsRouter);
  app.use("/api/projects", projectSettingsRouter);
  app.use("/api/projects", benchesSettingsRouter);
  app.use("/api/projects", integrationRouter);
  app.use("/api/plugins", pluginsRouter);
  app.use("/api/marketplace", marketplaceRouter);
  app.use("/api/migration", migrationRouter);
  app.use("/api/jigs", appJigsRouter);
  app.use("/api/containers", containersRouter);
  app.use("/api/filesystem/browse", filesystemRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/plugins/github-com/oauth", pluginsGithubOauthRouter);
  app.use("/api/hooks", hooksRouter);
  app.use("/api/notifications", notificationsRouter);
  // WU-061 / FR-079: env-gated e2e reset route. The handler returns 404 when
  // ROUBO_E2E !== "1", so this mount is safe in production builds.
  app.use("/test", testRouter);

  app.get("/api/benches", (req, res) => {
    let benches = benchManager.getBenches();
    const issue = parseInt(req.query.issue as string, 10);
    if (!isNaN(issue)) {
      // The ?issue= filter targets GitHub issue numbers. Alert-backed benches reuse
      // assignedIssue.number for the alert number, so skip them to avoid colliding
      // with a real issue #N. See #291.
      benches = benches.filter(
        (b) => b.assignedIssue?.number === issue && !isAlertExternalId(b.assignedIssue?.externalId),
      );
    }
    res.json(benches);
  });

  const clientDist = resolveClientDist(__dirname);
  app.use(express.static(clientDist));
  app.get("/{*path}", (_req, res, next) => {
    if (_req.path.startsWith("/api")) return next();
    // `dotfiles: "allow"` is required because the absolute server path may
    // contain components that start with a dot (e.g. a workspace under
    // `~/.roubo/...`). The `send` library defaults to `ignore`, which makes
    // it 404 any sendFile whose path passes through a dot-prefixed segment,
    // breaking the SPA fallback for every non-root URL.
    res.sendFile(path.join(clientDist, "index.html"), { dotfiles: "allow" }, (err) => {
      if (err) next();
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  // Initialize the project registry, run pending migrations, and bring up the
  // plugin manager BEFORE we bind the HTTP listener. This avoids a startup
  // race where the client could fetch /api/projects/:id/integration during
  // the window between `app.listen()` and `pluginManager.initialize()`
  // resolving, which returned `installed: false` for a bundled plugin like
  // github-com and surfaced the WU-015 missing-plugin dialog spuriously.
  console.log("Initializing project registry...");
  projectRegistry.initialize();

  // FR-018 (issue #558): capture the fresh-install signal BEFORE the migration
  // check runs, because `migrate.run()` writes state.json even on the greenfield
  // path. The notice seeding below uses this to decide whether to show the
  // changed-default banner (existing installs) or seed it as already-satisfied
  // (fresh installs).
  const freshInstall = migrate.isFreshInstall();

  console.log("Running migration check...");
  try {
    const outcome = await migrate.run();
    if (outcome.status === "success") {
      console.log(
        `Migration: bumped schemaVersion (${outcome.migratedProjectIds.length} projects)`,
      );
    } else if (outcome.status === "rolled-back") {
      console.warn(`Migration rolled back: ${outcome.reason ?? "unknown error"}`);
    }
  } catch (err) {
    console.error("Migration check failed:", (err as Error).message);
  }

  // FR-018 (issue #558): seed the one-time only-to-do default-change notice
  // marker. Fresh installs are seeded as already-satisfied; existing installs
  // get a boot timestamp so the banner shows once. Failure here must not block
  // boot, so it is logged and swallowed like the migration check above.
  try {
    migrate.seedOnlyToDoNotice(freshInstall);
  } catch (err) {
    console.error("Only-to-do notice seeding failed:", (err as Error).message);
  }

  console.log("Initializing plugin manager...");
  try {
    await pluginManager.initialize();
  } catch (err) {
    console.error("Plugin manager initialization failed:", (err as Error).message);
  }

  // Wire the component-plugin crash-cleanup / auto-recovery hooks (issue #613).
  // The supervisor fires these when a `component` plugin crashes: pre-restart
  // reaps the resources the plugin owned (no orphans, no duplicate containers on
  // restart), and restarted re-provisions its components (auto-recovery). They
  // are injected (not imported) to avoid a plugin-manager → bench-manager cycle.
  pluginManager.registerComponentPluginHooks({
    onComponentPluginPreRestart: benchManager.handleComponentPluginPreRestart,
    onComponentPluginRestarted: benchManager.handleComponentPluginRestarted,
  });

  // Run integration backfills after the plugin runtime is up: the github-com
  // sources derivation issues a `listSourceCandidates` RPC, which needs a
  // ready plugin manager. Subscribes for later registerProject/reloadConfig
  // calls too.
  initializeIntegrationMigrations();

  // Prime the legacy github service's in-memory token cache from the github-com
  // plugin's keychain slot. The cache backs the synchronous getOctokit() path
  // used by projects, benches, etc., which are not yet plugin-driven.
  try {
    await githubService.refreshAuth();
  } catch (err) {
    console.warn("Failed to load GitHub credentials from keychain:", (err as Error).message);
  }

  let server: http.Server;
  try {
    server = await new Promise<http.Server>((resolve, reject) => {
      const s = app.listen(requestedPort, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
  } catch (err) {
    wss.close();
    await pluginManager.shutdown().catch(() => undefined);
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

  console.log("Initializing bench manager...");
  benchManager.initialize();

  // Startup orphan sweep (issue #613): replay the ledger and reap any compose
  // project that escaped a hard host kill (matching `roubo-<projectId>-bench-<N>`
  // only), before reconcile rebuilds the live bench view. Best-effort: a failure
  // here must not block boot.
  console.log("Sweeping orphaned compose projects...");
  await benchManager.sweepOrphanedComposeProjects().catch((err) => {
    console.error("Startup orphan sweep failed:", (err as Error).message);
  });

  console.log("Reconciling state with system...");
  await benchManager.reconcile();

  console.log("Loading persisted terminal sessions...");
  terminalService.loadPersistedSessions();

  console.log("Starting jig watchers...");
  jigManager.startAppJigsWatcher();
  for (const project of projectRegistry.getProjects()) {
    jigManager.startWatchers(project.id, project.repoPath);
  }

  const statusInterval = setInterval(() => {
    benchManager.refreshComponentStatuses().catch(console.error);
  }, 5000);

  if (!process.env.ROUBO_QUIET && process.env.ROUBO_VERSION) {
    void checkForUpdate(process.env.ROUBO_VERSION);
  }

  void detectClaudeAutoMode();

  // Fetch + verify the hosted marketplace catalog on launch so the first
  // Plugins-view open serves a fresh, verified catalog and the on-disk cache is
  // warmed for offline degrade (CPHM-FR-001 / FR-009). Fire-and-forget: the
  // client degrades to cache/seed internally and never throws, so this must not
  // block or crash boot.
  void catalogClient.prefetch();

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    clearInterval(statusInterval);
    jigManager.stopAllWatchers();
    terminalService.destroyAllSessions();
    await new Promise<void>((r) => wss.close(() => r()));
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
