import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  DISALLOWED_SHA256,
  findDisallowedRefs,
  scanTrackedFiles,
  sha256,
} from "./repo-reference-guard.mjs";

// An invented name stands in for the real one, which this file must not spell.
const NAME = "roubo-exampleprivate";
const DIGESTS = new Set([sha256(NAME)]);

describe("findDisallowedRefs (RepoReferenceGuard)", () => {
  it("flags an issue citation in a comment, keyed by path and line", () => {
    const src = `const a = 1;\n// Fixed in acme/${NAME}#123.\nconst b = 2;\n`;
    expect(findDisallowedRefs("server/x.ts", src, DIGESTS)).toEqual([
      { key: "server/x.ts:2", text: `// Fixed in acme/${NAME}#123.` },
    ]);
  });

  it("flags a link to the repository", () => {
    const src = `{ "url": "https://github.com/acme/${NAME}/issues/1" }\n`;
    expect(findDisallowedRefs("docs/x.json", src, DIGESTS)).toHaveLength(1);
  });

  it("flags the name used as a fixture project id", () => {
    const src = `render(<AgentOverridesSection projectId="${NAME}" />);\n`;
    expect(findDisallowedRefs("client/x.test.tsx", src, DIGESTS)).toHaveLength(1);
  });

  it("matches regardless of case", () => {
    expect(findDisallowedRefs("README.md", `See ${NAME.toUpperCase()}.\n`, DIGESTS)).toHaveLength(
      1,
    );
  });

  it("reports every matching line, not just the first", () => {
    const src = `${NAME}\nclean\n${NAME}\n`;
    expect(findDisallowedRefs("a.md", src, DIGESTS).map((f) => f.key)).toEqual([
      "a.md:1",
      "a.md:3",
    ]);
  });

  it("passes other roubo-* tokens and a meta-repo layout", () => {
    const src = "roubo#1 fixed it. layout:\n  type: meta-repo\nroubo-plugins#37 roubo-otherword\n";
    expect(findDisallowedRefs("a.md", src)).toEqual([]);
  });

  it("skips binary contents", () => {
    expect(findDisallowedRefs("a.png", `\0PNG${NAME}`, DIGESTS)).toEqual([]);
  });

  it("guards at least one name, stored only as a SHA-256 digest", () => {
    expect(DISALLOWED_SHA256.size).toBeGreaterThan(0);
    for (const digest of DISALLOWED_SHA256) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("repo-reference-guard CLI and tracked-file scan", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A git repo whose path contains a space, which percent-encodes in a file URL.
  function repoWith(files: Record<string, string>, tracked: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "repo refs "));
    dirs.push(root);
    for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
    execFileSync("git", ["init", "-q"], { cwd: root });
    if (tracked.length > 0) execFileSync("git", ["add", "--", ...tracked], { cwd: root });
    return root;
  }

  it("scans tracked files only", () => {
    const root = repoWith({ "a.md": `${NAME}\n`, "b.md": `${NAME}\n` }, ["a.md"]);
    expect(scanTrackedFiles(root, DIGESTS).map((f) => f.key)).toEqual(["a.md:1"]);
  });

  it("runs the scan when invoked directly from a path containing a space", () => {
    const root = repoWith({ "a.md": "clean\n" }, ["a.md"]);
    mkdirSync(join(root, "bin dir"));
    const script = join(root, "bin dir", "repo-reference-guard.mjs");
    copyFileSync(fileURLToPath(new URL("./repo-reference-guard.mjs", import.meta.url)), script);
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No disallowed repository references found.");
  });
});
