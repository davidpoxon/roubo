import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests drive the real update-electron-app against a fake Electron, so
// they prove what the library does with Roubo's options rather than what the
// options say. The library is CommonJS and requires "electron" itself, which
// vi.mock does not reach, so the fake is seeded into the require cache before
// the library loads.
const fake = await vi.hoisted(async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const autoUpdater = Object.assign(new Emitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  const app = {
    isPackaged: true,
    isReady: vi.fn(() => true),
    on: vi.fn(),
    getVersion: vi.fn(() => "1.0.0"),
    getAppPath: vi.fn(() => "/app"),
    relaunch: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const dialog = { showMessageBox: vi.fn() };
  return { app, autoUpdater, dialog };
});

vi.mock("electron", () => fake);

vi.mock("update-electron-app", () => {
  const require = createRequire(import.meta.url);
  const electronPath = require.resolve("electron");
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: fake,
  } as unknown as NodeJS.Module;
  const libPath = require.resolve("update-electron-app");
  delete require.cache[libPath];
  return require(libPath) as typeof import("update-electron-app");
});

import { startUpdater, updaterOptions, UPDATE_INTERVAL, UPDATE_REPO } from "./updater.js";

const MINUTE = 60 * 1000;
const STOCK_BUTTONS = ["Restart", "Later"];

const originalPlatform = process.platform;

function resetFake(): void {
  (fake.autoUpdater as EventEmitter).removeAllListeners();
  fake.autoUpdater.setFeedURL.mockReset();
  fake.autoUpdater.checkForUpdates.mockReset();
  fake.autoUpdater.quitAndInstall.mockReset();
  fake.app.relaunch.mockReset();
  fake.app.quit.mockReset();
  fake.app.exit.mockReset();
  fake.app.isPackaged = true;
  fake.dialog.showMessageBox.mockReset();
}

function emitDownloaded(): void {
  fake.autoUpdater.emit("update-downloaded", {}, "notes", "Roubo 1.1.0", new Date(), "https://x");
}

/** Lets the dialog's promise chain settle under fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function expectNoForcedRelaunch(): void {
  expect(fake.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  expect(fake.app.relaunch).not.toHaveBeenCalled();
  expect(fake.app.quit).not.toHaveBeenCalled();
  expect(fake.app.exit).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetFake();
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("updaterOptions", () => {
  it("HR-TC-042 keeps the stock restart-now-or-later dialog and checks hourly", () => {
    const options = updaterOptions();
    expect(options).toEqual({
      repo: UPDATE_REPO,
      updateInterval: UPDATE_INTERVAL,
      notifyUser: true,
    });
    expect(options.onNotifyUser).toBeUndefined();
    expect(UPDATE_INTERVAL).toBe("1 hour");
  });
});

describe("startUpdater", () => {
  it("does not start the updater outside the packaged app", () => {
    fake.app.isPackaged = false;
    startUpdater();
    expect(fake.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(fake.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("HR-TC-042 downloads in the background and checks again within the update interval", () => {
    startUpdater();
    expect(fake.autoUpdater.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://update.electronjs.org/${UPDATE_REPO}/darwin-${process.arch}/1.0.0`,
      }),
    );
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(fake.dialog.showMessageBox).not.toHaveBeenCalled();
    expectNoForcedRelaunch();
  });

  it("HR-TC-042 shows the stock dialog once a release is downloaded", async () => {
    fake.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    startUpdater();
    emitDownloaded();
    await settle();
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(fake.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        buttons: STOCK_BUTTONS,
        title: "Application Update",
        detail: "A new version has been downloaded. Restart the application to apply the updates.",
      }),
    );
  });

  it("HR-TC-042 never relaunches in the five minutes after the user chooses later", async () => {
    fake.dialog.showMessageBox.mockResolvedValue({ response: STOCK_BUTTONS.indexOf("Later") });
    startUpdater();
    emitDownloaded();
    await settle();
    vi.advanceTimersByTime(5 * MINUTE);
    await settle();
    expectNoForcedRelaunch();
  });

  it("HR-TC-043 never relaunches in the 60 minutes after an update downloads", async () => {
    // The dialog stays open, unanswered, for the whole hour: the update is
    // downloaded and the user has not chosen.
    fake.dialog.showMessageBox.mockReturnValue(new Promise(() => {}));
    startUpdater();
    emitDownloaded();
    for (let minute = 0; minute < 60; minute++) {
      vi.advanceTimersByTime(MINUTE);
      await settle();
    }
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expectNoForcedRelaunch();
  });

  it("HR-TC-043 never relaunches across an hour of checks after the user chooses later", async () => {
    fake.dialog.showMessageBox.mockResolvedValue({ response: STOCK_BUTTONS.indexOf("Later") });
    startUpdater();
    emitDownloaded();
    await settle();
    vi.advanceTimersByTime(60 * MINUTE);
    // The hourly check finds the release again and the stock dialog asks again.
    emitDownloaded();
    await settle();
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expectNoForcedRelaunch();
  });

  it("installs only when the user chooses restart in the stock dialog", async () => {
    fake.dialog.showMessageBox.mockResolvedValue({ response: STOCK_BUTTONS.indexOf("Restart") });
    startUpdater();
    expect(fake.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    emitDownloaded();
    await settle();
    expect(fake.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fake.app.relaunch).not.toHaveBeenCalled();
  });
});
