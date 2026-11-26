import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WATCH_TEST_FILES, WATCH_WAIT_MS } from "./watch-project.js";
import { createWaitFor } from "./watch-wait.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_IMPORT = 'from "../test/watch-wait.js"';
// Each entry point of a real watch, and the mocks that keep it off the file
// system: a mock of its own module, or of a module it starts its watch with.
const WATCH_ENTRY_POINTS: { call: string; mockedBy: RegExp[] }[] = [
  { call: "watchInput", mockedBy: [moduleMock("input-watcher")] },
  {
    call: "startStateDirWatch",
    mockedBy: [moduleMock("state-dir-watch"), moduleMock("input-watcher")],
  },
  {
    call: "startPluginDirWatch",
    mockedBy: [moduleMock("plugin-dir-watch"), moduleMock("input-watcher")],
  },
  ...["startWatchers", "startAppJigsWatcher", "watchProjectJigs"].map((call) => ({
    call,
    mockedBy: [moduleMock("jig-manager"), /vi\.spyOn\(fs, "watch"\)\.mockImplementation/],
  })),
];

function moduleMock(name: string): RegExp {
  return new RegExp(`vi\\.mock\\("[^"]*\\/${name}\\.js"`);
}

/** True when the source calls a watch entry point that none of its mocks covers. */
function startsRealWatch(text: string): boolean {
  return WATCH_ENTRY_POINTS.some(
    ({ call, mockedBy }) =>
      new RegExp(`\\b${call}\\(`).test(text) && !mockedBy.some((mock) => mock.test(text)),
  );
}

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
      return !listed.has(file) && (text.includes(HELPER_IMPORT) || startsRealWatch(text));
    });
    expect(missing).toEqual([]);
  });
});

describe("startsRealWatch", () => {
  it("counts a mock only for the watches it covers", () => {
    const jigMock = 'vi.mock("./jig-manager.js", () => ({}));\n';
    expect(startsRealWatch(`${jigMock}startWatchers("p", dir);`)).toBe(false);
    expect(startsRealWatch(`${jigMock}watchInput(file, options, handler);`)).toBe(true);
    expect(startsRealWatch('vi.mock("./input-watcher.js");\nstartStateDirWatch({ root });')).toBe(
      false,
    );
    expect(
      startsRealWatch('vi.mock("./state-dir-watch.js");\nstartPluginDirWatch({ root });'),
    ).toBe(true);
  });

  it("counts a spy on fs.watch only when it replaces the implementation", () => {
    expect(startsRealWatch('vi.spyOn(fs, "watch");\nstartWatchers("p", dir);')).toBe(true);
    expect(
      startsRealWatch(
        'vi.spyOn(fs, "watch").mockImplementation(() => w);\nstartWatchers("p", dir);',
      ),
    ).toBe(false);
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
