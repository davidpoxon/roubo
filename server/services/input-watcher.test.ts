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
  WatchRootError,
  formatApplyLogLine,
  watchInput,
  type Disposable,
  type HandlerResult,
  type InputChange,
} from "./input-watcher.js";
import {
  SELF_WRITE_TTL_MS,
  consumeSelfWrite,
  hashContent,
  markSelfWrite,
  resetSelfWriteTokens,
} from "./self-write-tokens.js";

const LINE_RE =
  /^\[input-watcher\] surface=\S+ path=\S+ outcome=(applied|rejected|deduped|self-write|refused) hash8=([0-9a-f]{8}|none) durationMs=\d+$/;

let base: string;
let stateDir: string;
let projectDir: string;
let outsideDir: string;
let lines: string[];
let watches: Disposable[];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 4_000) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out; log so far:\n${lines.join("\n")}`);
    await sleep(20);
  }
}

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
    expect(applyLines()).toHaveLength(1);
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
    await waitFor(() => seen.some((c) => c.path === added), 2_000);
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
    await waitFor(() => lines.some((l) => l.startsWith("[input-watcher] re-armed ")), 3_000);

    const added = path.join(plugins, "fresh");
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, "roubo-plugin.yaml"), "id: fresh\n");
    await waitFor(() => seen.some((c) => c.path === added), 2_000);
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
    await waitFor(() => lines.some((l) => l.startsWith("[input-watcher] re-armed ")), 3_000);

    fs.writeFileSync(file, "name: two\n");
    await waitFor(() => outcomeCount("applied") === 1, 2_000);
    expect(handler).toHaveBeenCalledWith({ path: file, hash: hashContent("name: two\n") });
    expect(lines.filter((l) => l.includes("re-armed"))).toEqual([
      `[input-watcher] re-armed path=${dir}`,
    ]);
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
    expect(outcomeLines).toHaveLength(5);
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
