import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRouboDir } from "./state.js";
import { DEFAULT_CONTEXT_WINDOW } from "@roubo/shared";

// process.env.SHELL is externally controlled and is used as the executable in
// execFileSync/pty.spawn. Restrict it to an absolute path of safe characters
// (the shape of every real login shell) before use. This both rejects unsafe
// values and is the barrier CodeQL's js/command-line-injection suite recognises
// as a sanitizer; see code-scanning alert #106.
const SAFE_SHELL_PATH_RE = /^\/[\w./-]+$/;

/**
 * Returns the user's login shell from $SHELL, validated to be an absolute path
 * containing only safe characters, falling back to /bin/sh when $SHELL is unset
 * or fails validation.
 */
export function getLoginShell(): string {
  const shell = process.env.SHELL;
  return shell && SAFE_SHELL_PATH_RE.test(shell) ? shell : "/bin/sh";
}

/**
 * Builds the argv for running `script` through the user's login shell.
 *
 * zsh reads `~/.zshrc` only for INTERACTIVE shells, and that is exactly where
 * the conventional nvm, fnm, and asdf snippets live, so a plain `-lc` login
 * shell cannot see them and `nvm use` fails with "command not found" (#628).
 * Adding `-i` for zsh makes those shell functions resolve.
 *
 * Other shells keep `-lc`. The `-i` flag is not a general fix: bash reads
 * `~/.bashrc` only for interactive NON-login shells, so `-i` would not load it
 * there either, and it costs a "no job control in this shell" warning on
 * stderr whenever the spawned shell has no tty.
 */
export function loginShellScriptArgs(script: string): [string, string] {
  const flags = path.basename(getLoginShell()) === "zsh" ? "-ilc" : "-lc";
  return [flags, script];
}

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

/** A shell variable name of the conventional shape, used to reject parse noise. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Imports the user's login shell environment into process.env, once at boot.
 *
 * A server launched from the Dock or Finder inherits launchd's minimal
 * environment, so everything the user exports from their shell profile (API
 * keys, proxy settings, version-manager shims) is missing. Bench terminals and
 * agent sessions both derive their child environment from process.env, and an
 * agent CLI is exec'd directly with an argv array (AP-NFR-001), so no shell
 * runs anywhere in that chain: the import has to happen here, at the server.
 *
 * Runs `env -0` through the login shell (via `loginShellScriptArgs`, so zsh is
 * also interactive and `~/.zshrc` loads) and splits the NUL-separated output,
 * which keeps values containing newlines intact. An existing process.env value
 * always wins and the import only fills gaps, matching `loadEnvFile()`'s
 * "explicit env wins" rule, which is what keeps harness overrides such as
 * ROUBO_E2E working.
 *
 * PATH is exempt from that gap-fill rule (it is always already set, so the rule
 * would skip it outright) and keeps its own merge: login-shell entries not
 * already present are prepended, preserving any paths injected by the launch
 * environment. ~/.local/bin (the standard user-local binary dir used by native
 * installers such as Claude Code) is then prepended when it exists on disk, and
 * the well-known macOS GUI CLI dirs appended, so tools installed there are found
 * even when the user's profile does not export them.
 *
 * Silently no-ops if the shell cannot be run (CI, containers, headless envs).
 */
export function importLoginShellEnv(): void {
  const shell = getLoginShell();
  try {
    const output = execFileSync(shell, loginShellScriptArgs("env -0"), {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let shellPath: string | undefined;
    for (const entry of output.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq);
      // A profile that prints to stdout prefixes the first entry, so anything
      // that is not a plain variable name is dropped rather than imported.
      if (!ENV_KEY_RE.test(key)) continue;
      const value = entry.slice(eq + 1);
      if (key === "PATH") {
        shellPath = value;
        continue;
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    if (shellPath) {
      // Merge: prepend login-shell paths not already present, preserving any
      // paths injected by the launch environment (e.g. version manager shims).
      const existing = process.env.PATH?.split(":") ?? [];
      const merged = [
        ...shellPath.split(":").filter((p) => p && !existing.includes(p)),
        ...existing,
      ];
      process.env.PATH = merged.join(":");
    }
  } catch (err) {
    // Keep the existing environment if the shell cannot be run.
    // Log at warn level so failures are visible in normal output.
    if (!process.env.ROUBO_QUIET) {
      console.warn("importLoginShellEnv: could not import the login-shell environment:", err);
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
  // Runs even when the import above failed, so the fallback is always available.
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

/**
 * Expands one manifest-declared install location to an absolute path, or returns
 * undefined when it is not a shape the host is willing to probe.
 *
 * `~/` expands against the server user's home. A relative path, a path carrying
 * a `..` segment, and a path still holding a `{{ }}` template are all dropped
 * rather than probed. `AgentInstallLocationsSchema` already rejects all three at
 * manifest-load time; re-checking here is deliberate, because this is the last
 * point before a plugin-supplied string can become a spawn target, and the
 * guarantee "a path outside the declared list is never spawned" should not rest
 * on a caller having validated first.
 */
function resolveDeclaredLocation(location: string): string | undefined {
  if (location.includes("{{")) return undefined;
  if (location.split("/").includes("..")) return undefined;
  const expanded = location.startsWith("~/")
    ? path.join(os.homedir(), location.slice(2))
    : location;
  return path.isAbsolute(expanded) ? expanded : undefined;
}

/**
 * Well-known install locations to probe for an agent CLI.
 *
 * `declared` is the `agentInstallLocations` list from the agent plugin's own
 * manifest (#712), and it is where per-agent candidates now live. The manifest
 * won that decision over the two alternatives: a host-side table keyed on more
 * base names would leave core accreting per-agent knowledge (the exact growth
 * `lint:agent-guard` / AP-NFR-006 exists to stop) and would never cover a
 * third-party agent, while carrying the list on the launch descriptor would put
 * machine-specific absolute paths on a per-launch contract that is meant to stay
 * declarative and host-agnostic. A manifest is install-time metadata, not a
 * per-launch instruction, so it carries neither objection, and it adds no spawn
 * capability a plugin did not already have: `resolveAgentCommand` returns any
 * `command` containing a path separator as-is, so a descriptor can already name
 * an absolute path today.
 *
 * A declared list REPLACES the table below rather than merging with it: a plugin
 * that says where its own CLI installs has given the whole answer for that CLI,
 * and merging would hand a third-party agent candidates belonging to somebody
 * else's binary.
 *
 * The switch below is the LEGACY DEFAULT, frozen at one base name. It exists
 * only because the bundled Claude Code plugin predates the manifest field. Every
 * other agent extends through its manifest, so this switch never grows another
 * arm and the guard's single-file allowlist never widens. An agent that is
 * neither known here nor declares anything resolves through PATH only, which is
 * exactly the behaviour it had before, plus an actionable error on a miss.
 *
 * Either way the host keeps doing the probing: every entry returned here is a
 * CANDIDATE, still gated on `isExecutableFile` and still first-match-wins, so a
 * plugin cannot cause an arbitrary path to be spawned.
 */
export function wellKnownPathsFor(command: string, declared?: readonly string[]): string[] {
  if (declared !== undefined && declared.length > 0) {
    return declared
      .map(resolveDeclaredLocation)
      .filter((location): location is string => location !== undefined);
  }
  switch (path.basename(command)) {
    case "claude":
      return [
        path.join(os.homedir(), ".local", "bin", "claude"),
        path.join(os.homedir(), ".claude", "local", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
      ];
    default:
      return [];
  }
}

/**
 * True when `p` is a regular file the current process may execute (#651).
 *
 * Bare existence is not enough: a directory, or a real-but-unchmodded file, at a
 * well-known install location would otherwise be handed to pty.spawn and surface
 * as an opaque EISDIR/EACCES. Gating on executability also stops a broken
 * ~/.local/bin/claude shadowing a working /opt/homebrew/bin/claude.
 */
function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Thrown by resolveAgentCommand when an agent CLI is found nowhere. */
export class AgentCommandNotFoundError extends Error {
  readonly command: string;
  readonly tried: string[];

  constructor(command: string, tried: string[]) {
    super(
      `Agent CLI "${command}" was not found on PATH or in any well-known install location. ` +
        `Tried: ${tried.length > 0 ? tried.join(", ") : "(nothing: PATH is empty)"}`,
    );
    this.name = "AgentCommandNotFoundError";
    this.command = command;
    this.tried = tried;
  }
}

/**
 * Resolves an agent CLI command to something spawnable, in this order (#645):
 *
 * 1. A command containing a path separator is an explicit path: returned as-is.
 * 2. A command found as an executable file on `searchPath` is returned unchanged,
 *    so the exec call resolves it exactly as it does today. Returning the bare
 *    name (rather than the first matching directory entry) keeps this step a
 *    probe, not a reimplementation of execvp's own search.
 * 3. Otherwise the first well-known install location holding an executable file,
 *    so a session launched from an agent plugin finds the CLI on installs whose
 *    PATH the server process never inherits (notably per-user shims and GUI
 *    launches). The candidates come from the agent plugin's own manifest
 *    when it declares `agentInstallLocations` (#712), and otherwise from the
 *    legacy basename table in `wellKnownPathsFor`.
 * 4. On a total miss, throws AgentCommandNotFoundError naming every location
 *    tried, rather than leaving an opaque ENOENT to surface from the PTY.
 *
 * `searchPath` defaults to the server's own PATH; callers spawning with a
 * modified PATH should pass the child's. `declaredLocations` is the launching
 * plugin's manifest-declared candidate list, if it declared one.
 */
export function resolveAgentCommand(
  command: string,
  searchPath: string | undefined = process.env.PATH,
  declaredLocations?: readonly string[],
): string {
  if (command.includes(path.sep) || command.includes("/")) return command;

  const tried: string[] = [];
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    tried.push(candidate);
    if (isExecutableFile(candidate)) return command;
  }

  // Resolved once and then reused for both the probe and the error, so the
  // locations the miss reports are exactly the ones that were tried.
  const wellKnown = wellKnownPathsFor(command, declaredLocations);
  const found = wellKnown.find(isExecutableFile);
  if (found !== undefined) return found;
  tried.push(...wellKnown);

  throw new AgentCommandNotFoundError(command, tried);
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
 * Returns the Claude context window size (tokens) to use for jig usage estimates.
 * Reads ROUBO_CONTEXT_WINDOW from process.env (set either in the OS environment or via
 * $ROUBO_DIR/.env). Falls back to DEFAULT_CONTEXT_WINDOW when unset or invalid.
 */
export function getContextWindow(): number {
  const raw = process.env.ROUBO_CONTEXT_WINDOW;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    console.warn(
      `ROUBO_CONTEXT_WINDOW "${raw}" is not a positive integer: using default ${DEFAULT_CONTEXT_WINDOW}`,
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
