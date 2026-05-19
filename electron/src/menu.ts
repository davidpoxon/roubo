import { Menu, BrowserWindow, app } from "electron";
import type { MenuItemConstructorOptions } from "electron";

export interface MenuOptions {
  isDev: boolean;
  isMac: boolean;
  onNavigate: (path: string) => void;
}

export function buildMenuTemplate(opts: MenuOptions): MenuItemConstructorOptions[] {
  const { isDev, isMac, onNavigate } = opts;

  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: "about" },
    { type: "separator" },
    {
      label: "Settings\u2026",
      accelerator: "CmdOrCtrl+,",
      click: () => onNavigate("/settings"),
    },
    {
      label: "Check for Updates\u2026",
      click: () => onNavigate("/updates"),
    },
    { type: "separator" },
    ...(isMac
      ? [
          { role: "services" as const },
          { type: "separator" as const },
          { role: "hide" as const },
          { role: "hideOthers" as const },
          { role: "unhide" as const },
          { type: "separator" as const },
        ]
      : []),
    { role: "quit" },
  ];

  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    ...(isDev ? [{ role: "toggleDevTools" as const }] : []),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  const windowSubmenu: MenuItemConstructorOptions[] = [
    { role: "minimize" },
    { role: "close" },
    ...(isMac
      ? [{ role: "zoom" as const }, { type: "separator" as const }, { role: "front" as const }]
      : []),
  ];

  return [
    { label: "Roubo", submenu: appSubmenu },
    { label: "Edit", submenu: editSubmenu },
    { label: "View", submenu: viewSubmenu },
    { label: "Window", submenu: windowSubmenu },
  ];
}

export function installApplicationMenu(win: BrowserWindow): void {
  const onNavigate = (path: string): void => {
    win.webContents.send("menu-navigate", path);
  };

  const template = buildMenuTemplate({
    isDev: !app.isPackaged,
    isMac: process.platform === "darwin",
    onNavigate,
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
