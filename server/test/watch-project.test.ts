import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WATCH_TEST_FILES, WATCH_WAIT_MS } from "./watch-project.js";
import { createWaitFor } from "./watch-wait.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_IMPORT = 'from "../test/watch-wait.js"';
// A test that starts one of these for real waits on the file system.
const REAL_WATCH = /\b(watchInput|startStateDirWatch|startPluginDirWatch)\(/;
// A test that mocks the module of the watch does not.
const MOCKED_WATCH = /vi\.mock\("[^"]*\/(input-watcher|state-dir-watch|plugin-dir-watch)\.js"/;

function serverTestFiles(dir = path.join(repoRoot, "server")): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serverTestFiles(full));
    else if (entry.name.endsWith(".test.ts")) out.push(path.relative(repoRoot, full));
  }
  return out.sort();
}

function source(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), "utf-8");
}

describe("the watch test project (#1726)", () => {
  it("lists only files that exist and use the shared waitFor", () => {
    for (const file of WATCH_TEST_FILES) {
      const text = source(file);
      expect(text, file).toContain(HELPER_IMPORT);
      expect(text, file).not.toMatch(/function waitFor\b/);
    }
  });

  it("holds every server test file that uses the shared waitFor or starts a real watch", () => {
    const listed = new Set(WATCH_TEST_FILES);
    const self = path.relative(repoRoot, fileURLToPath(import.meta.url));
    const missing = serverTestFiles().filter((file) => {
      if (file === self) return false;
      const text = source(file);
      const mocksTheWatch = MOCKED_WATCH.test(text);
      return (
        !listed.has(file) &&
        (text.includes(HELPER_IMPORT) || (REAL_WATCH.test(text) && !mocksTheWatch))
      );
    });
    expect(missing).toEqual([]);
  });
});

describe("createWaitFor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns once the condition holds", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 30);
    await createWaitFor(() => "unused")(() => ready);
    expect(ready).toBe(true);
  });

  it("fails after the one budget with the file's diagnostics", async () => {
    vi.useFakeTimers();
    const waitFor = createWaitFor(() => "log so far:\nline one");
    const result = waitFor(() => false).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(WATCH_WAIT_MS - 100);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const err = await result;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `timed out after ${WATCH_WAIT_MS} ms; log so far:\nline one`,
    );
  });
});
