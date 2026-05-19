import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRouboDir } from "./state.js";
import { DEFAULT_CONTEXT_WINDOW } from "@roubo/shared";

function parseEnvFile(): Array<{ key: string; raw: string }> {
  const envFile = path.join(getRouboDir(), ".env");
  if (!fs.existsSync(envFile)) return [];
  const contents = fs.readFileSync(envFile, "utf-8");
  const entries: Array<{ key: string; raw: string }> = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    entries.push({ key, raw: line.slice(eq + 1).trim() });
  }
  return entries;
}

/**
 * Well-known directories containing CLI binaries for common macOS GUI apps.
 * Appended to PATH as a fallback when shell resolution does not include them
 * (e.g. VS Code not yet configured via "Shell Command: Install 'code' command in PATH").
 */
const WELL_KNOWN_CLI_DIRS_DARWIN: string[] = [
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
];

/**
 * Resolves the user's full login shell PATH and merges it into process.env.PATH.
 * This ensures child processes can find commands (e.g. `code`, `brew`) that are
 * only added to PATH via shell profile scripts, which a non-login server process
 * would otherwise not inherit.
 * Also unconditionally prepends ~/.local/bin (the standard user-local binary dir
 * used by native installers such as Claude Code) when it exists on disk, ensuring
 * tools installed there are found even when the user's shell profile does not
 * export it (e.g. GUI Finder/Dock launches, fish shell users).
 * Silently no-ops if shell resolution fails (CI, containers, headless envs).
 * Note: fish shell is not supported (it outputs PATH newline-separated, not
 * colon-separated), so resolution is skipped when SHELL points to fish.
 */
export function resolveShellPath(): void {
  const shell = process.env.SHELL || "/bin/sh";
  // fish outputs PATH entries newline-separated rather than colon-separated,
  // which would produce an invalid PATH value — skip the exec for fish only.
  // The well-known-dirs fallback below still runs for all shells.
  if (path.basename(shell) !== "fish") {
    try {
      const resolved = execFileSync(shell, ["-lc", 'echo "$PATH"'], {
        timeout: 2000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (resolved) {
        // Merge: prepend login-shell paths not already present, preserving any
        // paths injected by the launch environment (e.g. version manager shims).
        const existing = process.env.PATH?.split(":") ?? [];
        const merged = [
          ...resolved.split(":").filter((p) => p && !existing.includes(p)),
          ...existing,
        ];
        process.env.PATH = merged.join(":");
      }
    } catch (err) {
      // Keep existing PATH if shell resolution fails.
      // Log at warn level so failures are visible in normal output.
      if (!process.env.ROUBO_QUIET) {
        console.warn("resolveShellPath: could not resolve login-shell PATH:", err);
      }
    }
  }

  // Prepend ~/.local/bin when it exists and isn't already in PATH.
  // This is the standard user-local binary prefix on both macOS and Linux, and is
  // where native Claude Code installs land. Prepending (not appending) matches the
  // fix the Claude CLI itself recommends: `$HOME/.local/bin:$PATH`.
  const userLocalBin = path.join(os.homedir(), ".local", "bin");
  if (!process.env.PATH?.split(":").includes(userLocalBin) && fs.existsSync(userLocalBin)) {
    process.env.PATH = [userLocalBin, process.env.PATH].filter(Boolean).join(":");
  }

  // Append well-known CLI directories that exist on disk but aren't in PATH yet.
  // These act as a fallback for GUI apps whose CLIs aren't symlinked into PATH.
  // Runs for all shells (including fish) so the fallback is always available.
  if (process.platform === "darwin") {
    const currentParts = new Set(process.env.PATH?.split(":") ?? []);
    const extras = WELL_KNOWN_CLI_DIRS_DARWIN.filter(
      (d) => !currentParts.has(d) && fs.existsSync(d),
    );
    if (extras.length > 0) {
      process.env.PATH = [process.env.PATH, ...extras].filter(Boolean).join(":");
    }
  }
}

const WELL_KNOWN_CLAUDE_PATHS = [
  path.join(os.homedir(), ".local", "bin", "claude"),
  path.join(os.homedir(), ".claude", "local", "claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

/**
 * Resolves the absolute path to the Claude CLI and stores it in process.env.ROUBO_CLAUDE_BINARY.
 * Resolution order: login-shell `command -v claude`, then well-known install locations, then
 * bare 'claude' (relies on PATH; spawn will throw a descriptive error if not found).
 * Silently no-ops on failure — the bare-name fallback ensures backwards-compatible behaviour.
 */
export function resolveClaudeBinary(): void {
  const shell = process.env.SHELL || "/bin/sh";
  if (path.basename(shell) !== "fish") {
    try {
      const resolved = execFileSync(shell, ["-lc", "command -v claude"], {
        timeout: 2000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (resolved) {
        process.env.ROUBO_CLAUDE_BINARY = resolved;
        return;
      }
    } catch {
      // fall through to well-known paths
    }
  }

  for (const p of WELL_KNOWN_CLAUDE_PATHS) {
    if (fs.existsSync(p)) {
      process.env.ROUBO_CLAUDE_BINARY = p;
      return;
    }
  }
  // No path found — leave ROUBO_CLAUDE_BINARY unset; getClaudeBinary() returns 'claude'.
}

/** Returns the resolved absolute path to the Claude CLI, or 'claude' as a fallback. */
export function getClaudeBinary(): string {
  return process.env.ROUBO_CLAUDE_BINARY ?? "claude";
}

/** Returns a copy of process.env with internal ROUBO_ variables stripped, for use in child process environments. */
export function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("ROUBO_"),
    ),
  );
}

/** Returns the variable names defined in $ROUBO_DIR/.env without their values. */
export function getEnvFileKeys(): string[] {
  return parseEnvFile().map((e) => e.key);
}

/**
 * Returns the Claude context window size (tokens) to use for blueprint usage estimates.
 * Reads ROUBO_CONTEXT_WINDOW from process.env (set either in the OS environment or via
 * $ROUBO_DIR/.env). Falls back to DEFAULT_CONTEXT_WINDOW when unset or invalid.
 */
export function getContextWindow(): number {
  const raw = process.env.ROUBO_CONTEXT_WINDOW;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    console.warn(
      `ROUBO_CONTEXT_WINDOW "${raw}" is not a positive integer — using default ${DEFAULT_CONTEXT_WINDOW}`,
    );
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Loads $ROUBO_DIR/.env and merges vars into process.env.
 * Existing process.env values take precedence (explicit env wins).
 * Silently no-ops if the file doesn't exist.
 */
export function loadEnvFile(): void {
  for (const { key, raw } of parseEnvFile()) {
    if (!(key in process.env)) {
      // Strip surrounding quotes (single or double). Limitations: does not
      // handle escaped quotes within the value (e.g. "value \"with\" quotes")
      // and does not detect mismatched pairs (e.g. "value'). Sufficient for
      // the primary use case of API keys that don't contain escape sequences.
      process.env[key] =
        raw.length >= 2 &&
        ((raw[0] === '"' && raw[raw.length - 1] === '"') ||
          (raw[0] === "'" && raw[raw.length - 1] === "'"))
          ? raw.slice(1, -1)
          : raw;
    }
  }
}
