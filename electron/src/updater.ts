import { app } from "electron";
import { updateElectronApp, type IUpdateElectronAppOptions } from "update-electron-app";

export const UPDATE_REPO = "davidpoxon/roubo";
export const UPDATE_INTERVAL = "1 hour";

/**
 * The options Roubo passes to update-electron-app (HR-FR-018).
 *
 * A new release downloads in the background through Electron's autoUpdater.
 * `notifyUser` keeps the library's stock restart-now-or-later dialog, and no
 * `onNotifyUser` callback replaces it with a Roubo-styled notice. Only the
 * dialog's Restart button installs: Later leaves the downloaded release in
 * place, and the platform updater applies it on the next quit. Nothing here
 * calls `quitAndInstall`, `app.relaunch` or `app.quit`, so Roubo never forces a
 * relaunch for an update.
 */
export function updaterOptions(): IUpdateElectronAppOptions {
  return { repo: UPDATE_REPO, updateInterval: UPDATE_INTERVAL, notifyUser: true };
}

/** Starts the background updater in the packaged app only. */
export function startUpdater(): void {
  if (!app.isPackaged) return;
  updateElectronApp(updaterOptions());
}
