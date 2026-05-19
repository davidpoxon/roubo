import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMenuTemplate, installApplicationMenu } from "./menu.js";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn().mockReturnValue({}), setApplicationMenu: vi.fn() },
  BrowserWindow: vi.fn(),
  app: { isPackaged: false },
}));

function submenu(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const entry = template.find((item) => item.label === label);
  if (!entry || !Array.isArray(entry.submenu)) throw new Error(`No submenu for ${label}`);
  return entry.submenu as MenuItemConstructorOptions[];
}

function roles(items: MenuItemConstructorOptions[]): (string | undefined)[] {
  return items.map((i) => i.role);
}

describe("buildMenuTemplate", () => {
  const navigate = vi.fn();

  beforeEach(() => {
    navigate.mockClear();
  });

  describe("app menu (Roubo)", () => {
    it("has About, Settings, Check for Updates, and Quit", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const items = submenu(template, "Roubo");
      const labels = items.map((i) => i.label ?? i.role);
      expect(labels).toContain("about");
      expect(labels).toContain("Settings\u2026");
      expect(labels).toContain("Check for Updates\u2026");
      expect(labels).toContain("quit");
    });

    it("Settings click calls onNavigate with /settings", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const items = submenu(template, "Roubo");
      const settings = items.find((i) => i.label === "Settings\u2026");
      if (!settings?.click) throw new Error("Settings item missing click handler");
      settings.click(undefined as never, undefined as never, undefined as never);
      expect(navigate).toHaveBeenCalledWith("/settings");
    });

    it("Check for Updates click calls onNavigate with /updates", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const items = submenu(template, "Roubo");
      const updates = items.find((i) => i.label === "Check for Updates\u2026");
      if (!updates?.click) throw new Error("Check for Updates item missing click handler");
      updates.click(undefined as never, undefined as never, undefined as never);
      expect(navigate).toHaveBeenCalledWith("/updates");
    });

    it("Settings accelerator is CmdOrCtrl+,", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const items = submenu(template, "Roubo");
      const settings = items.find((i) => i.label === "Settings\u2026");
      expect(settings?.accelerator).toBe("CmdOrCtrl+,");
    });

    it("includes macOS-only roles when isMac=true", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: true, onNavigate: navigate });
      const items = submenu(template, "Roubo");
      const allRoles = items.map((i) => i.role).filter(Boolean);
      expect(allRoles).toContain("services");
      expect(allRoles).toContain("hide");
      expect(allRoles).toContain("hideOthers");
      expect(allRoles).toContain("unhide");
    });

    it("omits macOS-only roles when isMac=false", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const items = submenu(template, "Roubo");
      const allRoles = items.map((i) => i.role).filter(Boolean);
      expect(allRoles).not.toContain("services");
      expect(allRoles).not.toContain("hide");
      expect(allRoles).not.toContain("hideOthers");
      expect(allRoles).not.toContain("unhide");
    });
  });

  describe("Edit menu", () => {
    it("contains undo, redo, cut, copy, paste, selectAll roles in order", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const items = submenu(template, "Edit").filter((i) => i.type !== "separator");
      expect(roles(items)).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    });
  });

  describe("View menu", () => {
    it("contains toggleDevTools when isDev=true", () => {
      const template = buildMenuTemplate({ isDev: true, isMac: false, onNavigate: navigate });
      const items = submenu(template, "View");
      expect(roles(items)).toContain("toggleDevTools");
    });

    it("omits toggleDevTools when isDev=false", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const items = submenu(template, "View");
      expect(roles(items)).not.toContain("toggleDevTools");
    });

    it("always contains reload, resetZoom, zoomIn, zoomOut, togglefullscreen", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const allRoles = roles(submenu(template, "View"));
      expect(allRoles).toContain("reload");
      expect(allRoles).toContain("resetZoom");
      expect(allRoles).toContain("zoomIn");
      expect(allRoles).toContain("zoomOut");
      expect(allRoles).toContain("togglefullscreen");
    });
  });

  describe("Window menu", () => {
    it("contains minimize and close on non-mac", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      expect(roles(submenu(template, "Window"))).toEqual(["minimize", "close"]);
    });

    it("contains zoom and front on macOS", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: true, onNavigate: navigate });
      const allRoles = roles(submenu(template, "Window"));
      expect(allRoles).toContain("zoom");
      expect(allRoles).toContain("front");
    });

    it("omits zoom and front on non-mac", () => {
      const template = buildMenuTemplate({ isDev: false, isMac: false, onNavigate: navigate });
      const allRoles = roles(submenu(template, "Window"));
      expect(allRoles).not.toContain("zoom");
      expect(allRoles).not.toContain("front");
    });
  });
});

describe("installApplicationMenu", () => {
  it("sends menu-navigate IPC when a navigating menu item is clicked", async () => {
    const { Menu } = await import("electron");
    const sendMock = vi.fn();
    const mockWin = {
      webContents: { send: sendMock },
    } as unknown as import("electron").BrowserWindow;

    vi.mocked(Menu.buildFromTemplate).mockImplementation((template) => {
      // Find and invoke the Settings click handler immediately as a side effect test
      for (const top of template) {
        if (!Array.isArray(top.submenu)) continue;
        for (const item of top.submenu as MenuItemConstructorOptions[]) {
          if (item.label === "Settings\u2026" && item.click) {
            item.click(undefined as never, undefined as never, undefined as never);
          }
        }
      }
      return {} as import("electron").Menu;
    });

    installApplicationMenu(mockWin);

    expect(sendMock).toHaveBeenCalledWith("menu-navigate", "/settings");
  });
});
