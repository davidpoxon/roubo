/**
 * InputWatcher against real temp directories and real chokidar. Only the state
 * dir and the registered project roots are redirected, so the allowlist cases
 * are deterministic; `atomicWrite` stays real so the self-write path is the one
 * the server runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hoisted = vi.hoisted(() => ({
  rouboDir: "",
  projects: [] as { id: string; repoPath: string }[],
}));
vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    ...actual,
    getRouboDir: () => hoisted.rouboDir,
    loadProjects: () => ({ projects: hoisted.projects }),
  };
});
vi.mock("chokidar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chokidar")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

import { watch } from "chokidar";
import { atomicWrite } from "./state.js";
import {
  DEFAULT_OUTCOME_REASONS,
  WatchRootError,
  formatApplyLogLine,
  hashInputFiles,
  logApply,
  watchInput,
  __test as inputWatcherTest,
  type Disposable,
  type HandlerResult,
  type InputChange,
} from "./input-watcher.js";
import {
  SELF_WRITE_TTL_MS,
  consumeSelfWrite,
  consumeSelfWrites,
  hashContent,
  markSelfWrite,
  noteInputContent,
  resetSelfWriteTokens,
} from "./self-write-tokens.js";
import { addClient, _resetClientsForTest } from "./sse.js";
import type { Response } from "express";
import type { InputChangedEvent } from "@roubo/shared";
import { createWaitFor, sleep } from "../test/watch-wait.js";

const LINE_RE =
  /^\[input-watcher\] surface=\S+ path=\S+ outcome=(applied|rejected|deduped|self-write|refused) hash8=([0-9a-f]{8}|none) durationMs=\d+$/;

let base: string;
let stateDir: string;
let projectDir: string;
let outsideDir: string;
let lines: string[];
let watches: Disposable[];

const waitFor = createWaitFor(() => `log so far:\n${lines.join("\n")}`);

function applyLines(): string[] {
  return lines.filter((l) => l.includes(" outcome="));
}

function outcomeCount(outcome: string): number {
  return applyLines().filter((l) => l.includes(` outcome=${outcome} `)).length;
}

function track(d: Disposable): Disposable {
  watches.push(d);
  return d;
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-input-watcher-")));
  stateDir = path.join(base, "state");
  projectDir = path.join(base, "project");
  outsideDir = path.join(base, "outside");
  for (const d of [stateDir, projectDir, outsideDir]) fs.mkdirSync(d, { recursive: true });
  hoisted.rouboDir = stateDir;
  hoisted.projects = [{ id: "proj", repoPath: projectDir }];
  resetSelfWriteTokens();
  lines = [];
  watches = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
});

afterEach(async () => {
  for (const w of watches) await w.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("watchInput allowlist", () => {
  it("HR-TC-046 rejects /etc/hosts with WatchRootError and creates no watcher", () => {
    const before = vi.mocked(watch).mock.calls.length;
    expect(() => watchInput("/etc/hosts", { surface: "test", settleMs: 50 }, vi.fn())).toThrow(
      WatchRootError,
    );
    expect(vi.mocked(watch).mock.calls.length).toBe(before);
  });

  it("HR-TC-046 accepts a path inside a project root and one inside the state dir", async () => {
    const inProject = path.join(projectDir, "roubo.yaml");
    const inState = path.join(stateDir, "settings.json");
    fs.writeFileSync(inProject, "a: 1\n");
    fs.writeFileSync(inState, "{}");
    const a = track(watchInput(inProject, { surface: "project", settleMs: 50 }, vi.fn()));
    const b = track(watchInput(inState, { surface: "settings", settleMs: 50 }, vi.fn()));
    await Promise.all([a.ready, b.ready]);
  });

  it("HR-TC-046 rejects a symlink inside a project root that resolves outside it", () => {
    const secret = path.join(outsideDir, "secret.json");
    fs.writeFileSync(secret, "{}");
    const link = path.join(projectDir, "linked.json");
    fs.symlinkSync(secret, link);
    const before = vi.mocked(watch).mock.calls.length;
    expect(() => watchInput(link, { surface: "project", settleMs: 50 }, vi.fn())).toThrow(
      WatchRootError,
    );
    expect(vi.mocked(watch).mock.calls.length).toBe(before);
  });

  it("HR-TC-046 refuses to arm a missing directory that later appears as a symlink outside every root", async () => {
    fs.writeFileSync(path.join(outsideDir, "a.txt"), "a");
    fs.writeFileSync(path.join(outsideDir, "b.txt"), "b");
    const plugins = path.join(stateDir, "plugins");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(
      watchInput(plugins, { surface: "plugin", settleMs: 50, rearmPollMs: 100 }, handler),
    );
    await w.ready;
    const before = vi.mocked(watch).mock.calls.length;

    fs.symlinkSync(outsideDir, plugins);
    await waitFor(() => lines.some((l) => l.includes("arm refused")));
    fs.writeFileSync(path.join(outsideDir, "a.txt"), "changed");
    await sleep(500);

    expect(handler).not.toHaveBeenCalled();
    expect(applyLines()).toEqual([]);
    expect(vi.mocked(watch).mock.calls.length).toBe(before);
    expect(lines.filter((l) => l.includes("arm refused"))).toEqual([
      `[input-watcher] arm refused path=${plugins} reason=outside-roots`,
    ]);
  });

  it("HR-TC-046 refuses unread an entry of a watched directory that is a symlink outside every root", async () => {
    fs.writeFileSync(path.join(outsideDir, "roubo-plugin.yaml"), "id: outside\n");
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const settled = vi.fn(async (): Promise<boolean> => true);
    const w = track(
      watchInput(plugins, { surface: "plugin", settleMs: 50, rearmPollMs: 100, settled }, handler),
    );
    await w.ready;

    const link = path.join(plugins, "linked");
    fs.symlinkSync(outsideDir, link);
    await waitFor(() => outcomeCount("refused") === 1);
    await sleep(200);

    expect(handler).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(applyLines()).toHaveLength(1);
    expect(applyLines()[0]).toMatch(LINE_RE);
    expect(applyLines()[0]).toContain(`path=${link} outcome=refused hash8=none `);
  });
});

describe("watchInput dedupe and self-write", () => {
  it("HR-TC-050 two events with identical content give one applied run and one deduped line", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(watchInput(file, { surface: "project", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1);
    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("deduped") === 1);
    await sleep(200);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ path: file, hash: hashContent("name: two\n") });
    expect(outcomeCount("applied")).toBe(1);
    expect(outcomeCount("deduped")).toBe(1);
  });

  it("atomicWrite marks its own write, so the matching event runs no handler and logs self-write", async () => {
    const file = path.join(stateDir, "settings.json");
    fs.writeFileSync(file, "{}");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(watchInput(file, { surface: "settings", settleMs: 50 }, handler));
    await w.ready;

    atomicWrite(file, '{"theme":"dark"}');
    await waitFor(() => outcomeCount("self-write") === 1);
    await sleep(200);

    expect(handler).not.toHaveBeenCalled();
    expect(applyLines()).toEqual([expect.stringContaining(" outcome=self-write ")]);
  });

  it("HR-TC-005 a delete after a rejected save runs the handler with a null hash, not deduped", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (change: InputChange): Promise<HandlerResult> =>
      change.hash === hashContent("name: bad\n") ? "rejected" : "applied",
    );
    const w = track(watchInput(file, { surface: "project", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: bad\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    fs.unlinkSync(file);
    await waitFor(() => handler.mock.calls.length === 2);
    await waitFor(() => outcomeCount("applied") === 1);

    expect(handler).toHaveBeenLastCalledWith({ path: file, hash: null });
    expect(outcomeCount("deduped")).toBe(0);
  });

  it("HR-TC-005 a save that restores the last applied content after a rejection runs the handler", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (change: InputChange): Promise<HandlerResult> =>
      change.hash === hashContent("name: bad\n") ? "rejected" : "applied",
    );
    const w = track(watchInput(file, { surface: "project", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: bad\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    fs.writeFileSync(file, "name: one\n");
    await waitFor(() => outcomeCount("applied") === 1);

    expect(handler).toHaveBeenLastCalledWith({ path: file, hash: hashContent("name: one\n") });
    expect(outcomeCount("deduped")).toBe(0);
  });

  it("HR-TC-052 a re-arm rescan does not run the handler again on unchanged rejected content", async () => {
    const dir = path.join(projectDir, "conf");
    const away = path.join(projectDir, "conf-away");
    fs.mkdirSync(dir);
    const file = path.join(dir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "rejected");
    const w = track(
      watchInput(file, { surface: "project", settleMs: 50, rearmPollMs: 100 }, handler),
    );
    await w.ready;

    fs.writeFileSync(file, "name: bad\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    fs.renameSync(dir, away);
    await sleep(300);
    fs.renameSync(away, dir);
    await waitFor(() => lines.some((l) => l.startsWith("[input-watcher] re-armed ")));
    await sleep(300);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomeCount("rejected")).toBe(1);
  });

  it("HR-TC-004 markRejected keeps a rejected app write rejected, so a hand save of the same content runs the handler", async () => {
    const file = path.join(stateDir, "settings.json");
    fs.writeFileSync(file, "{}");
    const handler = vi.fn(async (): Promise<HandlerResult> => "rejected");
    const w = track(watchInput(file, { surface: "settings", settleMs: 50 }, handler));
    await w.ready;

    const content = '{"theme":42}';
    atomicWrite(file, content);
    w.markRejected(file, hashContent(content));
    await waitFor(() => outcomeCount("self-write") === 1);
    expect(handler).not.toHaveBeenCalled();

    fs.writeFileSync(file, content);
    await waitFor(() => handler.mock.calls.length === 1);

    expect(handler).toHaveBeenCalledWith({ path: file, hash: hashContent(content) });
    expect(outcomeCount("deduped")).toBe(0);
  });

  it("HR-TC-041 markApplied drops a rejected record, so the next save of the same content is deduped", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "rejected");
    const w = track(watchInput(file, { surface: "project", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("rejected") === 1);

    // The surface applies the same content outside the watch.
    w.markApplied(file, hashContent("name: two\n"));
    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("deduped") === 1);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomeCount("rejected")).toBe(1);
  });

  it("holds self-write tokens as a multiset that consumes the oldest match and expires", () => {
    const file = path.join(stateDir, "state.json");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    markSelfWrite(file, "h1");
    markSelfWrite(file, "h1");
    expect(consumeSelfWrite(file, "h2")).toBe(false);
    expect(consumeSelfWrite(file, "h1")).toBe(true);
    expect(consumeSelfWrite(file, "h1")).toBe(true);
    expect(consumeSelfWrite(file, "h1")).toBe(false);

    markSelfWrite(file, "h3");
    now.mockReturnValue(1_000_000 + SELF_WRITE_TTL_MS + 1);
    expect(consumeSelfWrite(file, "h3")).toBe(false);
  });

  it("HR-TC-030 a change that matches no token clears the hand edit an earlier token carries", () => {
    const file = path.join(stateDir, "tracked.json");
    const write = (content: string) => fs.writeFileSync(file, content);
    write("seed");
    noteInputContent(file, hashContent("seed"));
    // H1, then app write A lands on it and carries the hand edit.
    write("h1");
    markSelfWrite(file, hashContent("a"), "a");
    write("a");
    // H2 before the run: the run reads H2 and matches no token.
    write("h2");
    noteInputContent(file, hashContent("h2"));
    expect(consumeSelfWrites(file, hashContent("h2"))).toEqual({
      hashes: [],
      carriesHandEdit: false,
    });
    // App write B: the run takes A and B in as the app's own writes.
    markSelfWrite(file, hashContent("b"), "b");
    write("b");
    expect(consumeSelfWrites(file, hashContent("b"))).toEqual({
      hashes: [hashContent("a"), hashContent("b")],
      carriesHandEdit: false,
    });
  });

  it("HR-TC-030 an absent input clears the hand edit an earlier token carries", () => {
    const file = path.join(stateDir, "gone.json");
    fs.writeFileSync(file, "seed");
    noteInputContent(file, hashContent("seed"));
    fs.writeFileSync(file, "h1");
    markSelfWrite(file, hashContent("a"), "a");
    fs.writeFileSync(file, "a");
    fs.rmSync(file);
    noteInputContent(file, null);
    expect(consumeSelfWrites(file, null)).toEqual({ hashes: [], carriesHandEdit: false });
    markSelfWrite(file, hashContent("b"), "b");
    fs.writeFileSync(file, "b");
    expect(consumeSelfWrites(file, hashContent("b")).carriesHandEdit).toBe(false);
  });
});

/**
 * Make the next watcher drop every event that chokidar sends in the first
 * `windowMs` after its `ready`. On macOS, the FSEvents stream behind
 * `fs.watch` goes live some milliseconds after chokidar says it is ready, and
 * a change in that window is lost (#1726). This makes that window certain.
 */
function dropEventsJustAfterReady(windowMs: number): void {
  const real = vi.mocked(watch).getMockImplementation();
  if (!real) throw new Error("expected the real chokidar watch behind the mock");
  vi.mocked(watch).mockImplementationOnce((paths, opts) => {
    const w = real(paths, opts);
    let readyAt: number | null = null;
    const emit = w.emit.bind(w);
    w.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === "ready") readyAt = Date.now();
      else if (readyAt !== null && event !== "error" && Date.now() - readyAt < windowMs) {
        return false;
      }
      return emit(event, ...args);
    }) as typeof w.emit;
    return w;
  });
}

describe("watchInput arm", () => {
  it("is ready only once the watch is live, so a change made just after ready is handled", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    dropEventsJustAfterReady(20);
    const w = track(watchInput(file, { surface: "project", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1);
    expect(handler).toHaveBeenCalledWith({ path: file, hash: hashContent("name: two\n") });
  });

  it("is re-armed only once the new watch is live, so a change made just after the re-armed line is handled", async () => {
    const dir = path.join(projectDir, "conf");
    const away = path.join(projectDir, "conf-away");
    fs.mkdirSync(dir);
    const file = path.join(dir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(
      watchInput(file, { surface: "project", settleMs: 50, rearmPollMs: 100 }, handler),
    );
    await w.ready;

    dropEventsJustAfterReady(50);
    fs.renameSync(dir, away);
    await sleep(300);
    fs.renameSync(away, dir);
    await waitFor(() => lines.some((l) => l.startsWith("[input-watcher] re-armed ")));
    // After the re-arm rescan, so only the watch can see the change.
    await sleep(20);

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1);
    expect(handler).toHaveBeenCalledWith({ path: file, hash: hashContent("name: two\n") });
  });
});

describe("watchInput lifecycle", () => {
  it("HR-TC-052 re-arms a watched directory that is renamed away and back, then handles a later change", async () => {
    const plugins = path.join(stateDir, "plugins");
    const away = path.join(stateDir, "plugins-away");
    fs.mkdirSync(path.join(plugins, "existing"), { recursive: true });
    fs.writeFileSync(path.join(plugins, "existing", "roubo-plugin.yaml"), "id: existing\n");
    const seen: InputChange[] = [];
    const handler = vi.fn(async (change: InputChange): Promise<HandlerResult> => {
      seen.push(change);
      return { outcome: "applied", action: "register" };
    });
    const w = track(
      watchInput(plugins, { surface: "plugin", settleMs: 50, rearmPollMs: 100 }, handler),
    );
    await w.ready;

    fs.renameSync(plugins, away);
    await sleep(500);
    fs.renameSync(away, plugins);
    await waitFor(() => lines.some((l) => l.startsWith("[input-watcher] re-armed ")));

    const added = path.join(plugins, "fresh");
    const startedAt = Date.now();
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, "roubo-plugin.yaml"), "id: fresh\n");
    await waitFor(() => seen.some((c) => c.path === added));
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const rearmed = lines.filter((l) => l.includes("re-armed"));
    expect(rearmed).toEqual([`[input-watcher] re-armed path=${plugins}`]);
    expect(rearmed[0]).not.toContain("outcome=");
    expect(lines.filter((l) => l.includes("error"))).toEqual([]);
    expect(seen.every((c) => c.path !== path.join(plugins, "existing"))).toBe(true);
    await waitFor(() => applyLines().some((l) => l.endsWith(" action=register")));
  });

  it("HR-TC-052 re-arms a directory renamed away and back within one default poll interval", async () => {
    const plugins = path.join(stateDir, "plugins");
    const away = path.join(stateDir, "plugins-away");
    fs.mkdirSync(path.join(plugins, "existing"), { recursive: true });
    fs.writeFileSync(path.join(plugins, "existing", "roubo-plugin.yaml"), "id: existing\n");
    const seen: InputChange[] = [];
    const handler = vi.fn(async (change: InputChange): Promise<HandlerResult> => {
      seen.push(change);
      return "applied";
    });
    // No rearmPollMs: the default one-second lifecycle poll.
    const w = track(watchInput(plugins, { surface: "plugin", settleMs: 50 }, handler));
    await w.ready;

    fs.renameSync(plugins, away);
    await sleep(150);
    fs.renameSync(away, plugins);
    await waitFor(() => lines.some((l) => l.startsWith("[input-watcher] re-armed ")));

    const added = path.join(plugins, "fresh");
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, "roubo-plugin.yaml"), "id: fresh\n");
    await waitFor(() => seen.some((c) => c.path === added));
    // Two more polls: a re-arm must not repeat once the watch is healthy.
    await sleep(2_100);

    expect(lines.filter((l) => l.includes("re-armed"))).toEqual([
      `[input-watcher] re-armed path=${plugins}`,
    ]);
    expect(lines.filter((l) => l.includes("error"))).toEqual([]);
  });

  it("HR-TC-052 re-arms a file watch whose parent directory is renamed away and back within one poll", async () => {
    const dir = path.join(projectDir, "conf");
    const away = path.join(projectDir, "conf-away");
    fs.mkdirSync(dir);
    const file = path.join(dir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(watchInput(file, { surface: "project", settleMs: 50 }, handler));
    await w.ready;

    fs.renameSync(dir, away);
    await sleep(150);
    fs.renameSync(away, dir);
    await waitFor(() => lines.some((l) => l.startsWith("[input-watcher] re-armed ")));

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1);
    expect(handler).toHaveBeenCalledWith({ path: file, hash: hashContent("name: two\n") });
    expect(lines.filter((l) => l.includes("re-armed"))).toEqual([
      `[input-watcher] re-armed path=${dir}`,
    ]);
  });

  it("HR-TC-055 arms a file watch on a missing file and handles the file once it appears", async () => {
    const file = path.join(stateDir, "settings.json");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(watchInput(file, { surface: "settings", settleMs: 50, kind: "file" }, handler));
    await w.ready;

    fs.writeFileSync(file, '{"theme":"dark"}');
    await waitFor(() => outcomeCount("applied") === 1);
    await sleep(200);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ path: file, hash: hashContent('{"theme":"dark"}') });
    expect(applyLines()).toHaveLength(1);
    expect(applyLines()[0]).toMatch(LINE_RE);
    expect(applyLines()[0]).toContain(`path=${file} outcome=applied `);
  });

  it("settles ready when the watch is disposed before chokidar is ready", async () => {
    const dir = path.join(stateDir, "plugins");
    fs.mkdirSync(dir);
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = watchInput(dir, { surface: "plugin", settleMs: 50 }, handler);
    await w.dispose();

    const settled = await Promise.race([w.ready.then(() => true), sleep(1_000).then(() => false)]);
    expect(settled).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("watchInput rescan", () => {
  /** The next watch gets a chokidar watcher whose file events never come. */
  async function dropNextWatchEvents(): Promise<void> {
    const actual = await vi.importActual<typeof import("chokidar")>("chokidar");
    vi.mocked(watch).mockImplementationOnce((...args) => {
      const watcher = actual.watch(...args);
      const on = watcher.on.bind(watcher) as (
        event: string,
        listener: (...a: unknown[]) => void,
      ) => typeof watcher;
      (watcher as { on: unknown }).on = (event: string, listener: (...a: unknown[]) => void) =>
        on(event, event === "all" ? () => {} : listener);
      return watcher;
    });
  }

  /** The next watch counts each file event that it gets. */
  async function countNextWatchEvents(): Promise<{ count: number }> {
    const seen = { count: 0 };
    const actual = await vi.importActual<typeof import("chokidar")>("chokidar");
    vi.mocked(watch).mockImplementationOnce((...args) => {
      const watcher = actual.watch(...args);
      watcher.on("all", () => {
        seen.count += 1;
      });
      return watcher;
    });
    return seen;
  }

  // The rescan hashes the files that the completeness gate lists, as the
  // plugin surface does.
  const rescan = { intervalMs: 100, files: () => ["roubo-plugin.yaml"] };
  const settled = async (): Promise<readonly string[]> => ["roubo-plugin.yaml"];

  it("HR-TC-013 runs a changed input whose file event never came once, on the next rescan", async () => {
    const plugins = path.join(stateDir, "plugins");
    const unit = path.join(plugins, "existing");
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(path.join(unit, "roubo-plugin.yaml"), "id: existing\n");
    // A file outside the rescan's list does not make an input differ.
    fs.writeFileSync(path.join(unit, "notes.txt"), "one");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    await dropNextWatchEvents();
    const w = track(
      watchInput(
        plugins,
        { surface: "plugin", settleMs: 50, rearmPollMs: 100, settled, rescan },
        handler,
      ),
    );
    await w.ready;

    fs.writeFileSync(path.join(unit, "notes.txt"), "two");
    await sleep(400);
    expect(handler).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(unit, "roubo-plugin.yaml"), "id: existing\nversion: 2\n");
    await waitFor(() => outcomeCount("applied") === 1);
    await sleep(400);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      path: unit,
      hash: hashInputFiles(unit, ["roubo-plugin.yaml"]),
    });
    expect(applyLines()).toHaveLength(1);
  });

  it("HR-TC-014 runs a new input whose file event never came, and does not run its rejection again", async () => {
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const handler = vi.fn(async (): Promise<HandlerResult> => "rejected");
    await dropNextWatchEvents();
    const w = track(
      watchInput(
        plugins,
        { surface: "plugin", settleMs: 50, rearmPollMs: 100, settled, rescan },
        handler,
      ),
    );
    await w.ready;

    const added = path.join(plugins, "fresh");
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, "roubo-plugin.yaml"), "id: fresh\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    await sleep(400);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(applyLines()).toHaveLength(1);
  });

  it("HR-TC-014 leaves a change whose file event came to that event's run", async () => {
    const plugins = path.join(stateDir, "plugins");
    const unit = path.join(plugins, "fresh");
    const manifest = path.join(unit, "roubo-plugin.yaml");
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(manifest, "id: fresh\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const events = await countNextWatchEvents();
    const w = track(
      watchInput(
        plugins,
        // A settle window much longer than the rescan interval, so several
        // rescans come while the event's run waits.
        { surface: "plugin", settleMs: 800, rearmPollMs: 100, settled, rescan },
        handler,
      ),
    );
    await w.ready;

    // A file the rescan does not hash opens the settle window first, so the
    // window is open before the rescan can see the manifest change.
    fs.writeFileSync(path.join(unit, "notes.txt"), "one");
    await waitFor(() => events.count > 0);
    fs.writeFileSync(manifest, "id: fresh\nversion: 2\n");
    // Three rescan intervals, inside the settle window: no rescan runs it.
    await sleep(300);
    expect(handler).not.toHaveBeenCalled();

    fs.writeFileSync(manifest, "id: fresh\nversion: 3\n");
    await waitFor(() => outcomeCount("applied") === 1);
    await sleep(400);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      path: unit,
      hash: hashInputFiles(unit, ["roubo-plugin.yaml"]),
    });
    expect(outcomeCount("applied")).toBe(1);
  });

  it("HR-TC-014 sends one incomplete notice for an input that the gate keeps finding incomplete", async () => {
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const gate = vi.fn(async (): Promise<boolean> => false);
    await dropNextWatchEvents();
    const w = track(
      watchInput(
        plugins,
        { surface: "plugin", settleMs: 50, rearmPollMs: 100, settled: gate, rescan },
        handler,
      ),
    );
    await w.ready;

    const added = path.join(plugins, "copying");
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, "roubo-plugin.yaml"), "id: copying\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    // A file the rescan does not hash goes on changing, as a copy that never
    // settles does.
    for (let i = 0; i < 6; i += 1) {
      fs.writeFileSync(path.join(added, "notes.txt"), String(i));
      await sleep(100);
    }

    expect(outcomeCount("rejected")).toBe(1);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();

    // A change to a file the rescan hashes gates the input again.
    fs.writeFileSync(path.join(added, "roubo-plugin.yaml"), "id: copying\nversion: 2\n");
    await waitFor(() => outcomeCount("rejected") === 2);
  });

  it("HR-TC-013 runs another input's dropped change while one input's completeness gate is held open", async () => {
    const plugins = path.join(stateDir, "plugins");
    const held = path.join(plugins, "copying");
    const other = path.join(plugins, "existing");
    fs.mkdirSync(held, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(held, "roubo-plugin.yaml"), "id: copying\n");
    fs.writeFileSync(path.join(other, "roubo-plugin.yaml"), "id: existing\n");
    let release: (() => void) | null = null;
    let holding = false;
    const gate = vi.fn(async (unit: string): Promise<readonly string[]> => {
      // Hold the gate of one input open, as a copy that has not settled does.
      if (holding && unit === held) await new Promise<void>((resolve) => (release = resolve));
      return ["roubo-plugin.yaml"];
    });
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    await dropNextWatchEvents();
    const w = track(
      watchInput(
        plugins,
        { surface: "plugin", settleMs: 50, rearmPollMs: 100, settled: gate, rescan },
        handler,
      ),
    );
    await w.ready;

    holding = true;
    fs.writeFileSync(path.join(held, "roubo-plugin.yaml"), "id: copying\nversion: 2\n");
    await waitFor(() => release !== null);
    const heldGates = (): number => gate.mock.calls.filter(([unit]) => unit === held).length;
    const gatedOnce = heldGates();

    fs.writeFileSync(path.join(other, "roubo-plugin.yaml"), "id: existing\nversion: 2\n");
    // The held gate never opens on its own, so the other input runs only if
    // the rescan goes on hashing it while the held run waits.
    await waitFor(() => handler.mock.calls.length === 1);
    expect(handler).toHaveBeenCalledWith({
      path: other,
      hash: hashInputFiles(other, ["roubo-plugin.yaml"]),
    });
    // The held input is not gated again while its run is pending.
    await sleep(300);
    expect(heldGates()).toBe(gatedOnce);

    (release as (() => void) | null)?.();
    await waitFor(() => handler.mock.calls.length === 2);
    expect(handler).toHaveBeenLastCalledWith({
      path: held,
      hash: hashInputFiles(held, ["roubo-plugin.yaml"]),
    });
  });

  it("HR-TC-046 refuses unread an input that turns into a symlink out of every root while its gate waits and gives up", async () => {
    fs.writeFileSync(path.join(outsideDir, "roubo-plugin.yaml"), "id: outside\n");
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const unit = path.join(plugins, "copying");
    // Whether each call of the surface's file list was given a symlink.
    const listedLinks: boolean[] = [];
    const files = vi.fn((abs: string): readonly string[] => {
      listedLinks.push(fs.lstatSync(abs).isSymbolicLink());
      return ["roubo-plugin.yaml"];
    });
    // The input is swapped for a symlink out of every root after the run's
    // root check, while its completeness gate waits, and the gate gives up.
    const gate = vi.fn(async (abs: string): Promise<boolean> => {
      fs.rmSync(abs, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, abs);
      return false;
    });
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    await dropNextWatchEvents();
    const w = track(
      watchInput(
        plugins,
        {
          surface: "plugin",
          settleMs: 50,
          rearmPollMs: 100,
          settled: gate,
          rescan: { intervalMs: 100, files },
        },
        handler,
      ),
    );
    await w.ready;

    fs.mkdirSync(unit);
    fs.writeFileSync(path.join(unit, "roubo-plugin.yaml"), "id: copying\n");
    await waitFor(() => outcomeCount("refused") === 1);
    // Later rescans find the input out of every root and leave it alone.
    await sleep(400);

    expect(outcomeCount("refused")).toBe(1);
    expect(outcomeCount("rejected")).toBe(0);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(listedLinks).not.toContain(true);
  });

  it("HR-TC-046 refuses unread an input that turns into a symlink out of every root while its gate waits and returns a file list", async () => {
    fs.writeFileSync(path.join(outsideDir, "roubo-plugin.yaml"), "id: outside\n");
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const unit = path.join(plugins, "copying");
    // The input is swapped for a symlink out of every root after the run's
    // root check, while its completeness gate waits, and the gate then says
    // the input is complete.
    const gate = vi.fn(async (abs: string): Promise<readonly string[]> => {
      fs.rmSync(abs, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, abs);
      return ["roubo-plugin.yaml"];
    });
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    await dropNextWatchEvents();
    const w = track(
      watchInput(
        plugins,
        { surface: "plugin", settleMs: 50, rearmPollMs: 100, settled: gate, rescan },
        handler,
      ),
    );
    await w.ready;

    fs.mkdirSync(unit);
    fs.writeFileSync(path.join(unit, "roubo-plugin.yaml"), "id: copying\n");
    await waitFor(() => outcomeCount("refused") === 1);
    // Later rescans find the input out of every root and leave it alone.
    await sleep(400);

    expect(outcomeCount("refused")).toBe(1);
    expect(outcomeCount("applied")).toBe(0);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("HR-TC-046 hashes a directory input that is a symlink out of every root as absent", () => {
    fs.writeFileSync(path.join(outsideDir, "roubo-plugin.yaml"), "id: outside\n");
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const link = path.join(plugins, "linked");
    fs.symlinkSync(outsideDir, link);

    expect(hashInputFiles(link, ["roubo-plugin.yaml"])).toBeNull();
    expect(hashInputFiles(link, null)).toBeNull();
  });
});

describe("watchInput logging", () => {
  it("HR-TC-055 writes exactly one key=value line per outcome and no other line naming the paths", async () => {
    const dir = path.join(projectDir, "inputs");
    fs.mkdirSync(dir);
    const names = ["applied.json", "rejected.json", "refused.json", "self.json"];
    for (const name of names) fs.writeFileSync(path.join(dir, name), "{}");
    const plan: Record<string, () => HandlerResult> = {
      "applied.json": () => "applied",
      "rejected.json": () => {
        throw new Error("bad input");
      },
      "refused.json": () => "refused",
    };
    const handler = vi.fn(async (change: InputChange) => plan[path.basename(change.path)]());
    const w = track(watchInput(dir, { surface: "settings", settleMs: 50, allow: names }, handler));
    await w.ready;

    fs.writeFileSync(path.join(dir, "applied.json"), '{"a":1}');
    await waitFor(() => outcomeCount("applied") === 1);
    fs.writeFileSync(path.join(dir, "applied.json"), '{"a":1}');
    await waitFor(() => outcomeCount("deduped") === 1);
    fs.writeFileSync(path.join(dir, "rejected.json"), '{"b":');
    await waitFor(() => outcomeCount("rejected") === 1);
    fs.writeFileSync(path.join(dir, "refused.json"), '{"c":1}');
    await waitFor(() => outcomeCount("refused") === 1);
    atomicWrite(path.join(dir, "self.json"), '{"d":1}');
    await waitFor(() => outcomeCount("self-write") === 1);
    await sleep(200);

    const outcomeLines = applyLines();
    expect(outcomeLines.map((l) => / outcome=(\S+) /.exec(l)?.[1])).toEqual([
      "applied",
      "deduped",
      "rejected",
      "refused",
      "self-write",
    ]);
    for (const line of outcomeLines) {
      expect(line).toMatch(LINE_RE);
      expect(line.trim().startsWith("{")).toBe(false);
    }
    const mentions = lines.filter((l) => l.includes(dir));
    expect(mentions).toEqual(outcomeLines);
  });

  it("HR-TC-055 still writes exactly one outcome line when disposed while the handler is awaited", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    let release: (value: HandlerResult) => void = () => {};
    const handler = vi.fn(
      () =>
        new Promise<HandlerResult>((resolve) => {
          release = resolve;
        }),
    );
    const w = track(watchInput(file, { surface: "project", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => handler.mock.calls.length === 1);
    await w.dispose();
    release("applied");
    await waitFor(() => applyLines().length === 1);
    await sleep(200);

    expect(applyLines()).toHaveLength(1);
    expect(applyLines()[0]).toMatch(LINE_RE);
    expect(applyLines()[0]).toContain(
      `path=${file} outcome=applied hash8=${hashContent("name: two\n").slice(0, 8)} `,
    );
  });

  it("HR-TC-055 keeps the caller's depth for a directory watch with allow", async () => {
    const plugins = path.join(stateDir, "plugins");
    const manifest = path.join(plugins, "p1", "roubo-plugin.yaml");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, "id: p1\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(
      watchInput(
        stateDir,
        { surface: "plugin", settleMs: 50, allow: ["plugins"], depth: 3 },
        handler,
      ),
    );
    await w.ready;

    fs.writeFileSync(manifest, "id: p1\nversion: 2\n");
    await waitFor(() => outcomeCount("applied") === 1);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ path: plugins }));
    expect(applyLines()[0]).toMatch(LINE_RE);
  });

  it("HR-TC-055 adds action=<action> on the plugin surface", () => {
    expect(
      formatApplyLogLine({
        surface: "plugin",
        path: "/p/x",
        outcome: "applied",
        hash8: "0123abcd",
        durationMs: 12,
        action: "register",
      }),
    ).toBe(
      "[input-watcher] surface=plugin path=/p/x outcome=applied hash8=0123abcd durationMs=12 action=register",
    );
  });

  it("mirrors each apply line into the e2e tap only under ROUBO_E2E=1, and the reset empties it", () => {
    const original = process.env.ROUBO_E2E;
    const line = {
      surface: "project-config",
      path: "/p/.roubo/roubo.yaml",
      outcome: "applied" as const,
      hash8: "0123abcd",
      durationMs: 3,
    };
    try {
      inputWatcherTest.resetE2EApplyLogTap();
      delete process.env.ROUBO_E2E;
      logApply(line);
      expect(inputWatcherTest.getE2EApplyLogTap()).toEqual([]);

      process.env.ROUBO_E2E = "1";
      logApply(line);
      expect(inputWatcherTest.getE2EApplyLogTap()).toEqual([formatApplyLogLine(line)]);

      inputWatcherTest.resetE2EApplyLogTap();
      expect(inputWatcherTest.getE2EApplyLogTap()).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.ROUBO_E2E;
      else process.env.ROUBO_E2E = original;
      inputWatcherTest.resetE2EApplyLogTap();
    }
  });

  it("HR-TC-047 never puts file content in a log line or a handler event", async () => {
    const settings = path.join(stateDir, "settings.json");
    const auth = path.join(stateDir, "auth.json");
    fs.writeFileSync(settings, "{}");
    fs.writeFileSync(auth, "{}");
    const events: InputChange[] = [];
    const handler = vi.fn(async (change: InputChange): Promise<HandlerResult> => {
      events.push(change);
      return "applied";
    });
    const w = track(
      watchInput(
        stateDir,
        { surface: "settings", settleMs: 50, allow: ["settings.json", "auth.json"] },
        handler,
      ),
    );
    await w.ready;

    fs.writeFileSync(settings, '{"token":"SECRET-MARKER"}');
    await waitFor(() => events.some((e) => e.path === settings));
    fs.writeFileSync(auth, '{"apiKey":"SECRET-MARKER-AUTH"}');
    await waitFor(() => events.some((e) => e.path === auth));
    await sleep(200);

    expect(lines.some((l) => l.includes("SECRET-MARKER"))).toBe(false);
    expect(events.some((e) => JSON.stringify(e).includes("SECRET-MARKER"))).toBe(false);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(["hash", "path"]);
    const authLine = applyLines().find((l) => l.includes(`path=${auth} `));
    expect(authLine).toMatch(LINE_RE);
    expect(
      authLine
        ?.split(" ")
        .slice(1)
        .map((kv) => kv.split("=")[0]),
    ).toEqual(["surface", "path", "outcome", "hash8", "durationMs"]);
  });
});

describe("watchInput input-changed events", () => {
  let streamed: unknown[];

  function streamClient(): Response {
    return {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      write: vi.fn((chunk: string) => {
        const match = /^data: (.*)\n\n$/s.exec(chunk);
        if (match) streamed.push(JSON.parse(match[1]));
        return true;
      }),
    } as unknown as Response;
  }

  function inputEvents(): InputChangedEvent[] {
    return streamed.filter(
      (e): e is InputChangedEvent => (e as { type?: string }).type === "input-changed",
    );
  }

  beforeEach(() => {
    _resetClientsForTest();
    streamed = [];
    addClient(streamClient());
  });

  afterEach(() => {
    _resetClientsForTest();
  });

  it("HR-TC-040 an applied roubo.yaml under two benches sends one event with surface, outcome, projectId, benchIds and summary", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => ({
      outcome: "applied",
      event: { projectId: "proj", benchIds: [3, 7], summary: "Project config applied" },
    }));
    const w = track(watchInput(file, { surface: "project-config", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1);
    await sleep(200);

    const events = inputEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "input-changed",
      surface: "project-config",
      outcome: "applied",
      projectId: "proj",
      benchIds: [3, 7],
      summary: "Project config applied",
    });
    expect(JSON.stringify(events[0])).not.toContain("name: two");
  });

  it("HR-TC-040 an invalid roubo.yaml sends one rejected event with error.path and error.first", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => ({
      outcome: "rejected",
      event: {
        projectId: "proj",
        error: { path: "roubo.yaml", first: "benches.max: expected a number" },
      },
    }));
    const w = track(watchInput(file, { surface: "project-config", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "benches: {max: many}\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    await sleep(200);

    const events = inputEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "input-changed",
      surface: "project-config",
      outcome: "rejected",
      projectId: "proj",
      error: { path: "roubo.yaml", first: "benches.max: expected a number" },
    });
    expect(events[0].summary).toMatch(/^Project /);
  });

  it("HR-TC-040 a deduped run and a self-write run send no event", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(watchInput(file, { surface: "project-config", settleMs: 50 }, handler));
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1);
    expect(inputEvents()).toHaveLength(1);
    expect(inputEvents()[0].summary).toBe("Project change applied");

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("deduped") === 1);
    atomicWrite(file, "name: three\n");
    await waitFor(() => outcomeCount("self-write") === 1);
    await sleep(200);

    expect(inputEvents()).toHaveLength(1);
  });

  it("sends no event for a surface outside the six known surfaces", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const w = track(
      watchInput(file, { surface: "project", settleMs: 50 }, async () => "applied" as const),
    );
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1);
    await sleep(100);

    expect(inputEvents()).toHaveLength(0);
  });

  it("HR-TC-040 a throwing handler sends a rejected event with the watch's projectId, error.path and error.first", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => {
      throw new Error("bad yaml near SECRET-MARKER");
    });
    const w = track(
      watchInput(
        file,
        { surface: "project-config", settleMs: 50, target: { projectId: "proj" } },
        handler,
      ),
    );
    await w.ready;

    fs.writeFileSync(file, "benches: [SECRET-MARKER\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    await sleep(200);

    const events = inputEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "input-changed",
      surface: "project-config",
      outcome: "rejected",
      projectId: "proj",
      summary: "Project change rejected",
      error: { path: "roubo.yaml", first: DEFAULT_OUTCOME_REASONS.threw },
    });
    expect(JSON.stringify(events[0])).not.toContain("SECRET-MARKER");
  });

  it("HR-TC-040 a symlink refused outside every root sends a refused event with the watch's pluginId, error.path and error.first", async () => {
    fs.writeFileSync(path.join(outsideDir, "roubo-plugin.yaml"), "id: outside\n");
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const w = track(
      watchInput(
        plugins,
        { surface: "plugin", settleMs: 50, target: { pluginId: "linked" } },
        handler,
      ),
    );
    await w.ready;

    fs.symlinkSync(outsideDir, path.join(plugins, "linked"));
    await waitFor(() => outcomeCount("refused") === 1);
    await sleep(200);

    expect(handler).not.toHaveBeenCalled();
    const events = inputEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "input-changed",
      surface: "plugin",
      outcome: "refused",
      pluginId: "linked",
      summary: "Plugin change refused",
      error: {
        path: path.join("plugins", "linked"),
        first: DEFAULT_OUTCOME_REASONS.outside,
      },
    });
  });

  it("HR-TC-040 an incomplete directory sends a rejected event with the watch's pluginId, error.path and error.first", async () => {
    const plugins = path.join(stateDir, "plugins");
    fs.mkdirSync(plugins);
    const handler = vi.fn(async (): Promise<HandlerResult> => "applied");
    const settled = vi.fn(async (): Promise<boolean> => false);
    const w = track(
      watchInput(
        plugins,
        { surface: "plugin", settleMs: 50, settled, target: { pluginId: "p1" } },
        handler,
      ),
    );
    await w.ready;

    fs.mkdirSync(path.join(plugins, "p1"));
    fs.writeFileSync(path.join(plugins, "p1", "partial.txt"), "x");
    await waitFor(() => outcomeCount("rejected") >= 1);
    await sleep(200);

    expect(handler).not.toHaveBeenCalled();
    const events = inputEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({
      outcome: "rejected",
      pluginId: "p1",
      error: { path: path.join("plugins", "p1"), first: DEFAULT_OUTCOME_REASONS.incomplete },
    });
  });

  it("HR-TC-040 a handler's own ids and error win over the watch's target and the default error", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const handler = vi.fn(async (): Promise<HandlerResult> => ({
      outcome: "rejected",
      event: {
        projectId: "other",
        error: { path: "roubo.yaml", first: "benches.max: expected a number" },
      },
    }));
    const w = track(
      watchInput(
        file,
        { surface: "project-config", settleMs: 50, target: { projectId: "proj" } },
        handler,
      ),
    );
    await w.ready;

    fs.writeFileSync(file, "benches: {max: many}\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    await sleep(200);

    expect(inputEvents()).toHaveLength(1);
    expect(inputEvents()[0]).toMatchObject({
      projectId: "other",
      error: { path: "roubo.yaml", first: "benches.max: expected a number" },
    });
  });

  it("HR-TC-040 a handler's rejection with no error still sends error.path and error.first", async () => {
    const file = path.join(projectDir, "roubo.yaml");
    fs.writeFileSync(file, "name: one\n");
    const w = track(
      watchInput(
        file,
        { surface: "project-config", settleMs: 50, target: { projectId: "proj" } },
        async () => "rejected" as const,
      ),
    );
    await w.ready;

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("rejected") === 1);
    await sleep(200);

    expect(inputEvents()).toHaveLength(1);
    expect(inputEvents()[0]).toMatchObject({
      projectId: "proj",
      error: { path: "roubo.yaml", first: DEFAULT_OUTCOME_REASONS.rejected },
    });
  });
});
