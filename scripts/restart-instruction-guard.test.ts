import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOW_MARKER,
  findRestartInstructions,
  scanTrackedFiles,
} from "./restart-instruction-guard.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("findRestartInstructions (RestartInstructionGuard)", () => {
  it("HR-TC-044 flags 'Restart Roubo', keyed by path and line", () => {
    const src = "# Install\n\n**5. Enable it.** Restart Roubo. Then grant consent.\n";
    expect(findRestartInstructions("docs/x.md", src)).toEqual([
      { key: "docs/x.md:3", text: "**5. Enable it.** Restart Roubo. Then grant consent." },
    ]);
  });

  it("HR-TC-044 matches any case, inflection and the relaunch and 'the app' phrasings", () => {
    const phrasings = [
      "restart Roubo",
      "RESTART ROUBO",
      "Relaunch Roubo",
      "re-launch roubo",
      "restarting Roubo",
      "after you restarted Roubo",
      "relaunches the app",
      "Restart the app",
    ];
    for (const p of phrasings) {
      expect(findRestartInstructions("a.md", `${p} to apply it.\n`), p).toHaveLength(1);
    }
  });

  it("HR-TC-044 flags a phrase that a line break splits", () => {
    const src = "Then\nrestart\n  Roubo to apply it.\n";
    expect(findRestartInstructions("a.md", src).map((f) => f.key)).toEqual(["a.md:2"]);
  });

  it("HR-TC-044 flags a UI string in client source", () => {
    const src = 'const STRINGS = {\n  hint: "Relaunch the app to load the plugin.",\n};\n';
    expect(findRestartInstructions("client/src/x.tsx", src).map((f) => f.key)).toEqual([
      "client/src/x.tsx:2",
    ]);
  });

  it("passes text that only names a restart of a bench, a plugin or the server", () => {
    const src = [
      "Restart bench 2 to reconnect.",
      "Restart with new config",
      "Restart the bench, or the plugin, to bind them again.",
      "when Roubo restarts, the session comes back as ended.",
      "Restart the application server.",
      "restart roubostore",
    ].join("\n");
    expect(findRestartInstructions("a.md", src)).toEqual([]);
  });

  it("allows a match on a line that carries the allow marker", () => {
    const src = `Relaunch Roubo to install the release. <!-- ${ALLOW_MARKER}: a release update -->\n`;
    expect(findRestartInstructions("a.md", src)).toEqual([]);
  });

  it("allows a split match when any line it spans carries the marker", () => {
    const src = `Then restart\nRoubo. // ${ALLOW_MARKER}: a release update\n`;
    expect(findRestartInstructions("a.ts", src)).toEqual([]);
  });

  it("does not let a marker on another line allow a match", () => {
    const src = `// ${ALLOW_MARKER}: a release update\nRestart Roubo.\n`;
    expect(findRestartInstructions("a.ts", src).map((f) => f.key)).toEqual(["a.ts:2"]);
  });

  it("reports every match, not just the first", () => {
    const src = "Restart Roubo.\nclean\nRelaunch Roubo. Restart the app.\n";
    expect(findRestartInstructions("a.md", src).map((f) => f.key)).toEqual([
      "a.md:1",
      "a.md:3",
      "a.md:3",
    ]);
  });

  it("skips binary contents", () => {
    expect(findRestartInstructions("a.png", "\0PNG Restart Roubo")).toEqual([]);
  });
});

describe("restart-instruction-guard CLI and tracked-file scan", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A git repo whose path contains a space, which percent-encodes in a file URL.
  function repoWith(files: Record<string, string>, tracked: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "restart guard "));
    dirs.push(root);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    if (tracked.length > 0) execFileSync("git", ["add", "--", ...tracked], { cwd: root });
    return root;
  }

  it("HR-TC-044 scans tracked files under docs/, client/src and README.md only", () => {
    const bad = "Restart Roubo.\n";
    const files = {
      "docs/a.md": bad,
      "docs/untracked.md": bad,
      "client/src/b.tsx": bad,
      "README.md": bad,
      "server/c.ts": bad,
      "client/other.md": bad,
    };
    const tracked = Object.keys(files).filter((f) => f !== "docs/untracked.md");
    const root = repoWith(files, tracked);
    expect(
      scanTrackedFiles(root)
        .map((f) => f.key)
        .sort(),
    ).toEqual(["README.md:1", "client/src/b.tsx:1", "docs/a.md:1"]);
  });

  it("HR-TC-044 leaves no instruction to restart Roubo in this repository's docs and client", () => {
    expect(scanTrackedFiles(REPO_ROOT)).toEqual([]);
  });

  it("exits 1 and names the finding when invoked directly from a path containing a space", () => {
    const root = repoWith({ "docs/a.md": "Restart Roubo.\n" }, ["docs/a.md"]);
    mkdirSync(join(root, "bin dir"));
    const script = join(root, "bin dir", "restart-instruction-guard.mjs");
    copyFileSync(
      fileURLToPath(new URL("./restart-instruction-guard.mjs", import.meta.url)),
      script,
    );
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("docs/a.md:1: Restart Roubo.");
  });

  it("exits 0 on a clean tree", () => {
    const root = repoWith({ "docs/a.md": "clean\n" }, ["docs/a.md"]);
    const script = fileURLToPath(new URL("./restart-instruction-guard.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No instructions to restart Roubo found.");
  });
});
