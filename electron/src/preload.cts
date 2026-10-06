import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("roubo", {
  onDeepLink: (callback: (url: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on("deep-link", listener);
    return () => ipcRenderer.removeListener("deep-link", listener);
  },
  onNavigate: (callback: (path: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string) => callback(path);
    ipcRenderer.on("menu-navigate", listener);
    return () => ipcRenderer.removeListener("menu-navigate", listener);
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app-version") as Promise<string>,
  platform: process.platform,
  setTitleBarOverlayTheme: (theme: "light" | "dark"): void => {
    ipcRenderer.send("set-title-bar-overlay-theme", theme);
  },
  setBadgeCount: (count: number): void => {
    ipcRenderer.send("set-badge-count", count);
  },
  writeClipboard: (text: string): Promise<boolean> =>
    ipcRenderer.invoke("clipboard-write-text", text) as Promise<boolean>,
  showNotification: (req: { title: string; body: string; routeTo?: string }): void => {
    ipcRenderer.send("show-notification", req);
  },
});
