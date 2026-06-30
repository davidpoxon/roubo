import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateElectronApp } from "update-electron-app";
import { resolveBootstrap, type ServerHandleLike } from "./bootstrap.js";
import { installApplicationMenu } from "./menu.js";
import { shutdownWithTimeout } from "./shutdown.js";

export function windowOpenHandler({ url }: { url: string }): {
  action: "deny";
} {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      void shell.openExternal(url);
    }
  } catch {
    // malformed URL — deny silently
  }
  return { action: "deny" };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must be .cjs — Electron requires ESM preloads to use .mjs + sandbox:false.
// Compiling preload.cts emits preload.cjs (CommonJS), which works with default sandbox:true.
export const PRELOAD_FILENAME = "preload.cjs";

if (app.isPackaged) {
  updateElectronApp({ repo: "davidpoxon/roubo", updateInterval: "1 hour" });
}

let serverHandle: ServerHandleLike | null = null;
let currentUrl: string | null = null;
let win: BrowserWindow | null = null;
// Only the most recent pre-ready deep link is kept; earlier ones are superseded.
let pendingDeepLinkUrl: string | null = null;
let isReady = false;

export function setWin(w: BrowserWindow | null): void {
  win = w;
}

export function setIsReady(ready: boolean): void {
  isReady = ready;
}

export function handleShowNotification(req: unknown): void {
  if (
    typeof req !== "object" ||
    req === null ||
    typeof (req as Record<string, unknown>).title !== "string" ||
    typeof (req as Record<string, unknown>).body !== "string"
  )
    return;
  if (win?.isFocused()) return;
  const { title, body, routeTo } = req as {
    title: string;
    body: string;
    routeTo?: string;
  };
  const notification = new Notification({ title, body });
  notification.on("click", () => {
    win?.restore();
    win?.focus();
    if (routeTo) win?.webContents.send("deep-link", routeTo);
  });
  notification.show();
}

export function handleSetBadgeCount(count: unknown): void {
  if (typeof count !== "number" || !Number.isFinite(count)) return;
  const n = Math.max(0, Math.floor(count));
  if (process.platform === "darwin") {
    app.dock?.setBadge(n > 0 ? "•" : "");
  } else if (process.platform === "linux") {
    win?.flashFrame(n > 0);
  }
  // TODO: Windows — use win.setOverlayIcon() for taskbar badge
}

export async function handleDeepLink(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "roubo:") return;

    if (parsed.hostname === "oauth" && parsed.pathname === "/github/callback") {
      const error = parsed.searchParams.get("error");
      if (error) {
        const errorMessages: Record<string, string> = {
          access_denied: "Access was denied. Please try connecting again.",
          application_suspended: "The GitHub application is suspended.",
        };
        dialog.showErrorBox(
          "GitHub Connection Failed",
          errorMessages[error] ?? `GitHub reported: ${error}. Please try again.`,
        );
        return;
      }

      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state");
      if (!code || !state) return;

      const baseUrl = serverHandle
        ? `http://127.0.0.1:${serverHandle.port}`
        : "http://localhost:3335";

      const res = await fetch(`${baseUrl}/api/plugins/github-com/oauth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error?: string;
        };
        dialog.showErrorBox("GitHub Connection Failed", body.error ?? `HTTP ${res.status}`);
        return;
      }
      // Notify the renderer so React Query can invalidate stale integration
      // state and the Configure dialog can flip to "connected" without
      // requiring the user to click Test connection first.
      if (win) {
        win.restore();
        win.focus();
        win.webContents.send("deep-link", url);
      }
    } else if (parsed.hostname === "project") {
      if (win) {
        win.restore();
        win.focus();
        win.webContents.send("deep-link", url);
      }
    }
  } catch {
    // Silently ignore — invalid URL or transient network error
  }
}

export function dispatchDeepLink(url: string): void {
  if (isReady) {
    void handleDeepLink(url);
  } else {
    pendingDeepLinkUrl = url;
  }
}

// macOS: protocol URL fires open-url on the already-running instance (register before ready)
app.on("open-url", (event, url) => {
  event.preventDefault();
  dispatchDeepLink(url);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith("roubo://"));
    if (url) {
      dispatchDeepLink(url);
    } else if (win) {
      // Plain re-launch (no deep link): bring the existing window to the front.
      win.restore();
      win.focus();
    }
  });

  app.setAsDefaultProtocolClient("roubo");

  const overlayTheme = {
    light: { color: "#fafaf9", symbolColor: "#44403c" },
    dark: { color: "#0c0a09", symbolColor: "#a8a29e" },
  };

  ipcMain.handle("app-version", () => app.getVersion());

  ipcMain.on("set-title-bar-overlay-theme", (_event, theme: "light" | "dark") => {
    if (!win || process.platform === "darwin") return;
    if (!(theme in overlayTheme)) return;
    win.setTitleBarOverlay({ ...overlayTheme[theme], height: 40 });
  });

  ipcMain.on("set-badge-count", (_event, count: unknown) => {
    handleSetBadgeCount(count);
  });

  ipcMain.on("show-notification", (_event, req: unknown) => {
    handleShowNotification(req);
  });

  function createWindow(url: string, retryUntilReady = false): void {
    const macOS = process.platform === "darwin";
    const newWin = new BrowserWindow({
      width: 1280,
      height: 820,
      titleBarStyle: macOS ? "hiddenInset" : "hidden",
      trafficLightPosition: macOS ? { x: 16, y: 13 } : undefined,
      titleBarOverlay: macOS ? undefined : { ...overlayTheme.light, height: 40 },
      backgroundColor: "#fafaf9",
      webPreferences: {
        preload: path.join(__dirname, PRELOAD_FILENAME),
      },
    });
    win = newWin;
    newWin.on("closed", () => {
      win = null;
    });
    newWin.webContents.setWindowOpenHandler(windowOpenHandler);
    if (retryUntilReady) {
      // Dev mode: Vite dev server may not be ready yet — poll until it responds.
      const attempt = (): void => {
        newWin.loadURL(url).catch(() => setTimeout(attempt, 500));
      };
      attempt();
    } else {
      void newWin.loadURL(url);
    }
  }

  app
    .whenReady()
    .then(async () => {
      const serverEntryUrl = app.isPackaged
        ? new URL("../resources/server/dist/index.js", import.meta.url).href
        : new URL("../../server/dist/index.js", import.meta.url).href;

      if (app.isPackaged && !process.env.ROUBO_SEED_DIR) {
        // Packaged builds stage the first-run seed cache under resources/seed/
        // (the signed catalog plus the built tarballs; see
        // electron/src/packaging/seed-bundle.ts). Point the plugin manager at
        // that location directly so seedRoot() does not have to derive the path
        // from the bundled server file's location, which mis-resolves in a
        // packaged build.
        process.env.ROUBO_SEED_DIR = path.join(process.resourcesPath, "seed");
      }

      const result = await resolveBootstrap({
        env: process.env,
        importServer: () => import(serverEntryUrl),
      });
      serverHandle = result.serverHandle;
      currentUrl = result.url;
      console.log("[roubo] loading", currentUrl);
      createWindow(currentUrl, serverHandle === null);
      if (win) installApplicationMenu(win);

      isReady = true;
      if (pendingDeepLinkUrl) {
        void handleDeepLink(pendingDeepLinkUrl);
        pendingDeepLinkUrl = null;
      }
    })
    .catch((err: unknown) => {
      console.error("[roubo] bootstrap failed:", err);
      app.quit();
    });

  app.on("window-all-closed", () => {
    void shutdownWithTimeout({ handle: serverHandle, timeoutMs: 5000 })
      .then(() => app.quit())
      .catch((err: unknown) => {
        console.error("[roubo] unexpected quit error:", err);
        process.exit(1);
      });
  });
}
