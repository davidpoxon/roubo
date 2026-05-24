import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mockNotificationClickHandler: (() => void) | null = null;
const mockNotificationShow = vi.fn();

// Importing main.js triggers its top-level app.whenReady().then() chain. The
// chain calls createWindow(), which constructs `new BrowserWindow(...)`. With
// BrowserWindow mocked via vi.fn().mockImplementation(arrow), the `new` call
// throws and main.ts logs "[roubo] bootstrap failed". These tests cover the
// exported helpers, not the bootstrap chain, so make whenReady never resolve
// and the chain never runs.
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    whenReady: vi.fn().mockReturnValue(new Promise(() => {})),
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    setAsDefaultProtocolClient: vi.fn(),
    getVersion: vi.fn().mockReturnValue("0.0.0-test"),
    dock: { setBadge: vi.fn() },
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    webContents: {
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    },
    loadURL: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn(),
    focus: vi.fn(),
    isFocused: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    flashFrame: vi.fn(),
  })),
  dialog: { showErrorBox: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  Notification: vi.fn().mockImplementation(function () {
    return {
      show: mockNotificationShow,
      on: vi.fn().mockImplementation(function (event: string, cb: () => void) {
        if (event === "click") mockNotificationClickHandler = cb;
      }),
    };
  }),
  Menu: {
    buildFromTemplate: vi.fn().mockReturnValue({}),
    setApplicationMenu: vi.fn(),
  },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("update-electron-app", () => ({ updateElectronApp: vi.fn() }));
vi.mock("./bootstrap.js", () => ({ resolveBootstrap: vi.fn() }));
vi.mock("./menu.js", () => ({ installApplicationMenu: vi.fn() }));
vi.mock("./shutdown.js", () => ({ shutdownWithTimeout: vi.fn() }));

import { app, dialog, shell, Notification } from "electron";
import {
  windowOpenHandler,
  handleDeepLink,
  setWin,
  dispatchDeepLink,
  setIsReady,
  handleSetBadgeCount,
  handleShowNotification,
  PRELOAD_FILENAME,
} from "./main.js";

describe("PRELOAD_FILENAME", () => {
  it("ends with .cjs so Electron loads it as CommonJS with sandbox enabled", () => {
    expect(PRELOAD_FILENAME).toBe("preload.cjs");
  });
});

describe("windowOpenHandler", () => {
  beforeEach(() => {
    vi.mocked(shell.openExternal).mockClear();
  });

  it("opens http URLs in external browser and returns deny", async () => {
    const result = windowOpenHandler({ url: "http://example.com" });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledWith("http://example.com"));
    expect(result).toEqual({ action: "deny" });
  });

  it("opens https URLs in external browser and returns deny", async () => {
    const result = windowOpenHandler({
      url: "https://github.com/login/oauth/authorize",
    });
    await vi.waitFor(() =>
      expect(shell.openExternal).toHaveBeenCalledWith("https://github.com/login/oauth/authorize"),
    );
    expect(result).toEqual({ action: "deny" });
  });

  it("does not open file URLs externally and returns deny", () => {
    const result = windowOpenHandler({ url: "file:///etc/passwd" });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "deny" });
  });

  it("does not throw and returns deny for malformed URLs", () => {
    expect(() => windowOpenHandler({ url: "not a url !!!" })).not.toThrow();
    const result = windowOpenHandler({ url: "not a url !!!" });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "deny" });
  });
});

describe("handleDeepLink", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(dialog.showErrorBox).mockClear();
    setWin(null);
  });

  afterEach(() => {
    setIsReady(false);
    setWin(null);
  });

  it("silently ignores non-roubo URLs", async () => {
    await handleDeepLink("https://example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("silently ignores malformed URLs", async () => {
    await expect(handleDeepLink("not a url")).resolves.toBeUndefined();
  });

  it("POSTs code and state to /api/plugins/github-com/oauth/exchange for OAuth callback", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    await handleDeepLink("roubo://oauth/github/callback?code=abc123&state=xyz789");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/plugins/github-com/oauth/exchange"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "abc123", state: "xyz789" }),
      }),
    );
  });

  it("falls back to localhost:3335 for the exchange URL when serverHandle is null", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    await handleDeepLink("roubo://oauth/github/callback?code=abc&state=xyz");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3335/api/plugins/github-com/oauth/exchange",
      expect.anything(),
    );
  });

  it("silently ignores OAuth callback with missing code or state", async () => {
    await handleDeepLink("roubo://oauth/github/callback?code=abc");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("silently ignores fetch errors during OAuth exchange", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));
    await expect(
      handleDeepLink("roubo://oauth/github/callback?code=abc&state=xyz"),
    ).resolves.toBeUndefined();
  });

  it("silently ignores unknown roubo:// paths", async () => {
    await handleDeepLink("roubo://unknown/path");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows an error dialog when GitHub denies access", async () => {
    await handleDeepLink("roubo://oauth/github/callback?error=access_denied");
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      "GitHub Connection Failed",
      "Access was denied. Please try connecting again.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows an error dialog when the exchange endpoint returns an error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: "Invalid state" }),
    } as unknown as Response);
    await handleDeepLink("roubo://oauth/github/callback?code=abc&state=xyz");
    expect(dialog.showErrorBox).toHaveBeenCalledWith("GitHub Connection Failed", "Invalid state");
  });

  it("forwards the OAuth callback URL to the renderer after a successful exchange", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const mockWin = {
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    const callbackUrl = "roubo://oauth/github/callback?code=abc&state=xyz";
    await handleDeepLink(callbackUrl);
    expect(mockWin.restore).toHaveBeenCalled();
    expect(mockWin.focus).toHaveBeenCalled();
    expect(mockWin.webContents.send).toHaveBeenCalledWith("deep-link", callbackUrl);
  });

  it("does not send the OAuth callback URL to the renderer when the exchange fails", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: "Invalid state" }),
    } as unknown as Response);
    const mockWin = {
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    await handleDeepLink("roubo://oauth/github/callback?code=abc&state=xyz");
    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it("sends deep-link IPC and focuses the window for project navigation", async () => {
    const mockWin = {
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    await handleDeepLink("roubo://project/proj-123/bench/bench-456");
    expect(mockWin.restore).toHaveBeenCalled();
    expect(mockWin.focus).toHaveBeenCalled();
    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      "deep-link",
      "roubo://project/proj-123/bench/bench-456",
    );
  });
});

describe("dispatchDeepLink", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    setIsReady(false);
  });

  it("buffers the URL and does not call handleDeepLink when not yet ready", () => {
    // isReady is false by default; dispatchDeepLink should store the URL, not dispatch it
    dispatchDeepLink("roubo://oauth/github/callback?code=abc&state=xyz");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls handleDeepLink immediately when ready", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    setIsReady(true);
    dispatchDeepLink("roubo://oauth/github/callback?code=abc&state=xyz");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});

describe("handleSetBadgeCount", () => {
  const originalPlatform = process.platform;
  const mockDock = (app as unknown as { dock: { setBadge: ReturnType<typeof vi.fn> } }).dock;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    mockDock.setBadge.mockClear();
    setWin(null);
  });

  it("sets the dock badge to a bullet on macOS when count > 0", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    handleSetBadgeCount(3);
    expect(mockDock.setBadge).toHaveBeenCalledWith("•");
  });

  it("clears the dock badge on macOS when count is 0", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    handleSetBadgeCount(0);
    expect(mockDock.setBadge).toHaveBeenCalledWith("");
  });

  it("calls flashFrame(true) on Linux when count > 0", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    const mockWin = { flashFrame: vi.fn() };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    handleSetBadgeCount(2);
    expect(mockWin.flashFrame).toHaveBeenCalledWith(true);
  });

  it("calls flashFrame(false) on Linux when count is 0", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    const mockWin = { flashFrame: vi.fn() };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    handleSetBadgeCount(0);
    expect(mockWin.flashFrame).toHaveBeenCalledWith(false);
  });

  it("does nothing on win32", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    const mockWin = { flashFrame: vi.fn() };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    handleSetBadgeCount(5);
    expect(mockWin.flashFrame).not.toHaveBeenCalled();
    expect(mockDock.setBadge).not.toHaveBeenCalled();
  });

  it("ignores non-number input", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    handleSetBadgeCount("3");
    handleSetBadgeCount(null);
    handleSetBadgeCount(undefined);
    handleSetBadgeCount(NaN);
    handleSetBadgeCount(Infinity);
    expect(mockDock.setBadge).not.toHaveBeenCalled();
  });

  it("clamps negative input to 0", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    handleSetBadgeCount(-5);
    expect(mockDock.setBadge).toHaveBeenCalledWith("");
  });

  it("floors fractional input and shows bullet when result > 0", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    handleSetBadgeCount(2.9);
    expect(mockDock.setBadge).toHaveBeenCalledWith("•");
  });

  it("does not call flashFrame when win is null on Linux", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    setWin(null);
    expect(() => handleSetBadgeCount(1)).not.toThrow();
  });
});

describe("handleShowNotification", () => {
  const MockNotification = vi.mocked(Notification);

  beforeEach(() => {
    MockNotification.mockClear();
    mockNotificationShow.mockClear();
    mockNotificationClickHandler = null;
    setWin(null);
  });

  afterEach(() => {
    setWin(null);
  });

  it("does not show notification when window is focused", () => {
    const mockWin = {
      isFocused: vi.fn().mockReturnValue(true),
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    handleShowNotification({ title: "Hello", body: "World" });
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it("shows notification when window is not focused", () => {
    const mockWin = {
      isFocused: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    handleShowNotification({
      title: "Test title",
      body: "Test body",
    });
    expect(MockNotification).toHaveBeenCalledWith({
      title: "Test title",
      body: "Test body",
    });
    expect(mockNotificationShow).toHaveBeenCalled();
  });

  it("shows notification when win is null", () => {
    handleShowNotification({ title: "Test", body: "Body" });
    expect(MockNotification).toHaveBeenCalled();
    expect(mockNotificationShow).toHaveBeenCalled();
  });

  it("focuses window and navigates on click when routeTo is provided", () => {
    const mockWin = {
      isFocused: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    handleShowNotification({
      title: "Test",
      body: "Body",
      routeTo: "roubo://project/p1/bench/1",
    });
    expect(mockNotificationClickHandler).not.toBeNull();
    if (!mockNotificationClickHandler) throw new Error("click handler not registered");
    mockNotificationClickHandler();
    expect(mockWin.restore).toHaveBeenCalled();
    expect(mockWin.focus).toHaveBeenCalled();
    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      "deep-link",
      "roubo://project/p1/bench/1",
    );
  });

  it("focuses window without navigate on click when routeTo is absent", () => {
    const mockWin = {
      isFocused: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    setWin(mockWin as unknown as import("electron").BrowserWindow);
    handleShowNotification({ title: "Test", body: "Body" });
    if (!mockNotificationClickHandler) throw new Error("click handler not registered");
    mockNotificationClickHandler();
    expect(mockWin.restore).toHaveBeenCalled();
    expect(mockWin.focus).toHaveBeenCalled();
    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it("ignores invalid payload shapes", () => {
    handleShowNotification(null);
    handleShowNotification("string");
    handleShowNotification({ title: "only title" });
    handleShowNotification({ body: "only body" });
    expect(MockNotification).not.toHaveBeenCalled();
  });
});
