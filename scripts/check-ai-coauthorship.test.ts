import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectSources, findAiCoauthorViolations } from "./check-ai-coauthorship.mjs";

function violationsFor(text: string) {
  return findAiCoauthorViolations([{ label: "test", text }]);
}

describe("findAiCoauthorViolations", () => {
  it("passes a clean commit message with no co-authors", () => {
    const message = ["fix(jig): truncate long chip labels", "", "Closes #389"].join("\n");
    expect(violationsFor(message)).toEqual([]);
  });

  it("passes a legitimate human Co-Authored-By line (the false-positive guard)", () => {
    const message = [
      "feat: pair-programmed change",
      "",
      "Co-Authored-By: Ada Lovelace <ada@example.com>",
    ].join("\n");
    expect(violationsFor(message)).toEqual([]);
  });

  it("fails an AI Co-Authored-By line (Claude)", () => {
    const message = ["feat: something", "", "Co-Authored-By: Claude <noreply@anthropic.com>"].join(
      "\n",
    );
    const found = violationsFor(message);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toMatch(/AI-agent co-author/);
  });

  it("fails on a range of AI-agent co-author identities", () => {
    const identities = [
      "Claude Code <noreply@anthropic.com>",
      "GitHub Copilot <copilot@github.com>",
      "Cursor <cursor@example.com>",
      "Codex <codex@openai.com>",
      "ChatGPT <noreply@openai.com>",
      "GPT-4 <gpt@openai.com>",
      "Gemini <gemini@google.com>",
      "Devin <devin@cognition.ai>",
    ];
    for (const identity of identities) {
      const message = `feat: x\n\nCo-Authored-By: ${identity}`;
      expect(violationsFor(message), identity).toHaveLength(1);
    }
  });

  it("matches an AI co-author via the email even when the name looks human", () => {
    const message = "feat: x\n\nCo-Authored-By: Helper Bot <noreply@anthropic.com>";
    expect(violationsFor(message)).toHaveLength(1);
  });

  it("fails the robot-emoji attribution footer", () => {
    const message = "feat: x\n\n🤖 Generated with Claude Code";
    const found = violationsFor(message);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.some((v) => v.reason.includes("footer"))).toBe(true);
  });

  it("fails a 'Generated with [Claude Code]' footer", () => {
    const message = "feat: x\n\nGenerated with [Claude Code](https://claude.com/claude-code)";
    expect(violationsFor(message)).not.toHaveLength(0);
  });

  it("fails a noreply@anthropic.com co-author footer", () => {
    const message = "feat: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>";
    expect(violationsFor(message)).toHaveLength(1);
  });

  it("scans the PR body surface and reports its label", () => {
    const sources = [
      { label: "commit abc1234 (feat: x)", text: "feat: x\n\nCloses #1" },
      { label: "PR body", text: "This PR does things.\n\n🤖 Generated with Claude Code" },
    ];
    const found = findAiCoauthorViolations(sources);
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("PR body");
  });

  it("returns no violations for a non-array input", () => {
    // @ts-expect-error exercising the defensive guard
    expect(findAiCoauthorViolations(undefined)).toEqual([]);
    // @ts-expect-error exercising the defensive guard
    expect(findAiCoauthorViolations(null)).toEqual([]);
  });

  it("ignores sources whose text is not a string", () => {
    // @ts-expect-error exercising the defensive guard
    expect(findAiCoauthorViolations([{ label: "x", text: 42 }, null])).toEqual([]);
  });
});

describe("collectSources", () => {
  // collectSources runs `git log` in the process cwd, so each test builds a
  // throwaway repo with known commits and chdirs into it. This keeps the tests
  // hermetic and independent of how the host repo is cloned (CI uses a shallow
  // checkout, so relying on this repo's own HEAD~1 would be flaky).
  let repoDir: string;
  let originalCwd: string;

  function git(args: string[]): void {
    execFileSync("git", args, { cwd: repoDir, stdio: ["ignore", "ignore", "ignore"] });
  }

  function commit(subject: string): string {
    execFileSync("git", ["commit", "--allow-empty", "-m", subject], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    repoDir = mkdtempSync(join(tmpdir(), "roubo-coauthor-"));
    git(["init", "-q"]);
    git(["config", "user.email", "tester@example.com"]);
    git(["config", "user.name", "Tester"]);
    git(["config", "commit.gpgsign", "false"]);
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("collects one source per commit in a single-commit range plus the PR body", () => {
    const base = commit("chore: base commit");
    const head = commit("feat: add a thing");

    const sources = collectSources({
      baseSha: base,
      headSha: head,
      prBody: "This is the PR body.",
    });

    const commitSources = sources.filter((s) => s.label.startsWith("commit "));
    expect(commitSources).toHaveLength(1);
    expect(commitSources[0].label).toMatch(/^commit [0-9a-f]{7} \(feat: add a thing\)$/);
    expect(commitSources[0].text).toContain("feat: add a thing");

    const bodySources = sources.filter((s) => s.label === "PR body");
    expect(bodySources).toHaveLength(1);
    expect(bodySources[0].text).toBe("This is the PR body.");
  });

  it("omits the PR body source when the body is empty or whitespace", () => {
    const base = commit("chore: base commit");
    const head = commit("feat: add a thing");

    const sources = collectSources({ baseSha: base, headSha: head, prBody: "   " });
    expect(sources.some((s) => s.label === "PR body")).toBe(false);
    expect(sources.filter((s) => s.label.startsWith("commit "))).toHaveLength(1);
  });

  it("treats a range value as a single git revision argument (no shell injection)", () => {
    // A shell-meta payload as the range must not execute: with execFileSync it
    // is one argv element, so git rejects it as an unknown revision and the
    // function throws rather than running the injected command.
    expect(() => collectSources({ baseSha: "HEAD; touch roubo-injection-probe" })).toThrow(
      /Failed to list commits for range/,
    );
  });
});
