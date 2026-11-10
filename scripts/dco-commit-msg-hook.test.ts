import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = join(import.meta.dirname, "..");
const HOOKS_DIR = join(REPO_ROOT, "scripts", "git-hooks");
const HOOK = join(HOOKS_DIR, "commit-msg");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "dco-reusable.yml");

const COMMITTER = "Ada Lovelace <ada@example.com>";

function quotedStrings(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The `bot_authors=( … )` entries in the DCO workflow's verify step. */
function workflowBotAuthors(): string[] {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const run = workflow.jobs["dco-check"]?.steps.find((step) => step.id === "verify")?.run;
  const block = run?.match(/^\s*bot_authors=\(\n([\s\S]*?)\n\s*\)$/m)?.[1];
  const emails = block === undefined ? [] : quotedStrings(block);
  if (emails.length === 0) {
    throw new Error(`no bot_authors entries found in ${WORKFLOW}`);
  }
  return emails;
}

/**
 * The emails in the hook's bot-exemption `case` pattern. Every alternative
 * must be one double-quoted literal: an unquoted alternative could be a glob
 * that widens the exemption past the emails a quoted-string scan would see.
 */
function hookBotAuthors(): string[] {
  const block = readFileSync(HOOK, "utf8").match(
    /^case "\$author_email" in\n([\s\S]*?)\)\n\s*exit 0\n/m,
  )?.[1];
  if (block === undefined) {
    throw new Error(`no bot-exemption case block found in ${HOOK}`);
  }
  return block
    .replace(/\\\n/g, " ")
    .split("|")
    .map((alternative) => {
      const literal = alternative.trim().match(/^"([^"]+)"$/)?.[1];
      if (literal === undefined) {
        throw new Error(
          `case alternative ${alternative.trim()} in ${HOOK} is not one quoted email`,
        );
      }
      return literal;
    });
}

let repo: string;

/**
 * Run git in the temp repo with an environment of its own: no inherited GIT_*
 * variables (vitest may itself run under a hook), and no global or system
 * config, so the developer's hooks, signing and identity cannot leak in.
 */
function git(...args: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.HOME = repo;
  env.GIT_CONFIG_GLOBAL = join(repo, ".gitconfig-global");
  env.GIT_CONFIG_NOSYSTEM = "1";
  return spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
}

function commit(...args: string[]) {
  return git("commit", "--allow-empty", "-m", "test: a commit", ...args);
}

function commitCount(): number {
  const result = git("rev-list", "--count", "--all");
  return Number(result.stdout.trim());
}

describe("scripts/git-hooks/commit-msg", () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "roubo-dco-hook-"));
    writeFileSync(join(repo, ".gitconfig-global"), "");
    expect(git("init", "-q").status).toBe(0);
    git("config", "user.name", "Ada Lovelace");
    git("config", "user.email", "ada@example.com");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", HOOKS_DIR);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects a commit with no sign-off", () => {
    const result = commit();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing DCO sign-off matching <ada@example.com>");
    expect(commitCount()).toBe(0);
  });

  it("accepts a commit whose sign-off matches the author", () => {
    const result = commit("-s");
    expect(result.status, result.stderr).toBe(0);
    expect(git("log", "-1", "--format=%B").stdout).toContain(`Signed-off-by: ${COMMITTER}`);
  });

  it.each(workflowBotAuthors())("accepts an unsigned commit authored by %s", (email) => {
    const result = commit(`--author=Bot <${email}>`);
    expect(result.status, result.stderr).toBe(0);
    expect(git("log", "-1", "--format=%ae").stdout.trim()).toBe(email);
  });

  it("rejects a commit for another author that carries only the committer's sign-off", () => {
    const result = commit("--author=Grace Hopper <grace@example.com>", "-s");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing DCO sign-off matching <grace@example.com>");
    expect(commitCount()).toBe(0);
  });

  it("exempts exactly the bots that dco-reusable.yml lists in bot_authors", () => {
    expect([...hookBotAuthors()].sort()).toEqual([...workflowBotAuthors()].sort());
  });
});
