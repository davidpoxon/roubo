import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRouboDir } from "./state.js";
import { DEFAULT_CONTEXT_WINDOW } from "@roubo/shared";
import type { LoginShellImportStatus } from "@roubo/shared";

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
 * shell cannot see them and `nvm use` fails with "command not found" (#996).
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
 * Per-attempt timeout for the login-shell import. 5 s was too short after a
 * cold reboot, when nvm loading from ~/.zshrc can take longer (#1487).
 */
const LOGIN_SHELL_IMPORT_TIMEOUT_MS = 15_000;

/** The first attempt plus one retry, taken only after a timeout. */
const LOGIN_SHELL_IMPORT_ATTEMPTS = 2;

let loginShellImportStatus: LoginShellImportStatus = { state: "not-run" };

/** The outcome of the most recent `importLoginShellEnv()` call. */
export function getLoginShellImportStatus(): LoginShellImportStatus {
  return loginShellImportStatus;
}

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
 * ROUBO_E2E working. Boot runs `loadEnvFile()` first, so .env wins over the
 * shell. The import records the shell's value of each key it sets and of each
 * key .env set first, as a layer below .env: a later reload of .env overrides
 * a key that still holds the shell's value and puts the shell's value back
 * when .env drops a key, so a reload ends where a relaunch would.
 *
 * PATH is exempt from that gap-fill rule (it is always already set, so the rule
 * would skip it outright) and keeps its own merge: login-shell entries not
 * already present are prepended, preserving any paths injected by the launch
 * environment. ~/.local/bin (the standard user-local binary dir used by native
 * installers such as Claude Code) is then prepended when it exists on disk, and
 * the well-known macOS GUI CLI dirs appended, so tools installed there are found
 * even when the user's profile does not export them.
 *
 * Each attempt gets LOGIN_SHELL_IMPORT_TIMEOUT_MS, and a timed-out attempt is
 * retried once (#1487): after a cold reboot, a profile that loads nvm can take
 * longer than the old 5 s limit, and the second attempt runs against a warm
 * disk cache. Any other failure is not retried, since running the profile again
 * would not change it. The shell is killed with SIGKILL when the timeout fires,
 * because an interactive zsh ignores the default SIGTERM and spawnSync would
 * otherwise wait for the profile to finish on its own. The call is synchronous
 * and runs before the server listens, so a shell that never answers delays boot
 * by up to the two timeouts combined.
 *
 * If every attempt fails, the existing environment is kept, a warning is
 * logged, and the outcome is recorded for `getLoginShellImportStatus()`, which
 * `GET /api/system/status` reports so the app can tell the operator. This
 * function never throws (CI, containers, and headless envs may have no usable
 * shell).
 */
export function importLoginShellEnv(): void {
  const shell = getLoginShell();
  let lastError: unknown;
  let timedOut = false;
  let output: string | undefined;
  for (let attempt = 1; attempt <= LOGIN_SHELL_IMPORT_ATTEMPTS; attempt++) {
    try {
      output = execFileSync(shell, loginShellScriptArgs("env -0"), {
        timeout: LOGIN_SHELL_IMPORT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      break;
    } catch (err) {
      lastError = err;
      timedOut = (err as { code?: unknown }).code === "ETIMEDOUT";
      if (!timedOut) break;
    }
  }

  if (output === undefined) {
    // Keep the existing environment if the shell cannot be run.
    // Log at warn level so failures are visible in normal output.
    if (!process.env.ROUBO_QUIET) {
      console.warn("importLoginShellEnv: could not import the login-shell environment:", lastError);
    }
    loginShellImportStatus = {
      state: "failed",
      reason: timedOut ? "timeout" : "error",
      shell,
      timeoutMs: LOGIN_SHELL_IMPORT_TIMEOUT_MS,
      detail: lastError instanceof Error ? lastError.message : String(lastError),
    };
  } else {
    loginShellImportStatus = { state: "ok" };
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
      // The shell's value is a layer below .env: kept for a key the import
      // sets and for a key .env set first, so a reload of .env can override
      // the one and fall back to the other, as a relaunch would.
      if (!(key in process.env)) {
        process.env[key] = value;
        loginShellLayer.set(key, value);
      } else if (ownedByEnvFile(key)) {
        loginShellLayer.set(key, value);
      }
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
 * manifest (#1115), and it is where per-agent candidates now live. The manifest
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
 * True when `p` is a regular file the current process may execute (#1060).
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
 * Resolves an agent CLI command to something spawnable, in this order (#1056):
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
 *    when it declares `agentInstallLocations` (#1115), and otherwise from the
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
 * Strip surrounding quotes (single or double). Limitations: does not handle
 * escaped quotes within the value (e.g. "value \"with\" quotes") and does not
 * detect mismatched pairs (e.g. "value'). Sufficient for the primary use case
 * of API keys that don't contain escape sequences.
 */
function unquoteEnvValue(raw: string): string {
  return raw.length >= 2 &&
    ((raw[0] === '"' && raw[raw.length - 1] === '"') ||
      (raw[0] === "'" && raw[raw.length - 1] === "'"))
    ? raw.slice(1, -1)
    : raw;
}

/** The values of $ROUBO_DIR/.env by key, the first line of a key winning. */
function readEnvFileValues(): Map<string, string> {
  const values = new Map<string, string>();
  for (const { key, raw } of parseEnvFile()) {
    if (!values.has(key)) values.set(key, unquoteEnvValue(raw));
  }
  return values;
}

/**
 * Each key `loadEnvFile()` put in process.env, with the value it put there. A
 * later load may change or remove only these: a key the process had before,
 * or one something else has set since, is explicit env and wins.
 */
const envFileApplied = new Map<string, string>();
let envFileLoaded = false;

/**
 * The login-shell layer, below .env: each key `importLoginShellEnv()` set, or
 * would have set had .env not set it first, with the shell's value. A key the
 * process had from outside both is explicit env and is not in it. PATH is not
 * in it either: the import merges PATH rather than filling it.
 */
const loginShellLayer = new Map<string, string>();

/**
 * Keys only the first load applies. The server binds its port once at boot and
 * publishes the bound port back into ROUBO_PORT. ROUBO_PRODUCTION picks the
 * state dir, where this .env lives, once at module load, and boot checks
 * ROUBO_E2E against it; nothing here reads ROUBO_DIR. Plugin discovery reads
 * its two plugin roots once at boot. The app log reads ROUBO_APP_LOG_DIR on
 * each write but creates the folder and counts its bytes only on the first
 * write and after a rotation. NODE_ENV is read once by plugin discovery, to
 * pick the isolation probes, and by the app log install, and the plugin log
 * guard reads it on each open or rotation of a plugin log stream. A later edit
 * of these in .env must not reach process.env, or a per-call read of a plugin
 * root would move away from the root the plugins were found in, the app log
 * would append to a folder it never created and lose every later line, and
 * under NODE_ENV=test a plugin log stream opened or rotated under the default
 * plugins root would throw, while streams already open kept writing.
 *
 * So these keys are read once, at boot. A reload does not drop an edit of one
 * silently: `loadEnvFileReport()` names each one whose line a save changed to
 * a value a relaunch would apply, and the state dir watch sends a notice that
 * a relaunch is needed.
 */
const BOOT_ONLY_ENV_KEYS: ReadonlySet<string> = new Set([
  "ROUBO_PORT",
  "ROUBO_DIR",
  "ROUBO_PRODUCTION",
  "ROUBO_E2E",
  "ROUBO_USER_PLUGINS_DIR",
  "ROUBO_BUNDLED_PLUGINS_DIR",
  "ROUBO_APP_LOG_DIR",
  "NODE_ENV",
]);

/** Whether process.env holds `key` as the .env load left it, so a reload may change it. */
function ownedByEnvFile(key: string): boolean {
  const applied = envFileApplied.get(key);
  return applied !== undefined && process.env[key] === applied;
}

/** Whether process.env holds `key` as the login-shell import left it, so .env may override it. */
function ownedByLoginShell(key: string): boolean {
  const shell = loginShellLayer.get(key);
  return shell !== undefined && process.env[key] === shell;
}

/** Whether process.env holds `key` from outside .env and the login shell, so it wins over both. */
function isExplicitEnv(key: string): boolean {
  return key in process.env && !ownedByEnvFile(key) && !ownedByLoginShell(key);
}

/**
 * The .env line of each boot-only key as the last load read it, undefined when
 * the file had no line for it. A reload reports a boot-only key only when its
 * line differs from this, so a later save that leaves the line as it was does
 * not report it again.
 */
const bootOnlyLines = new Map<string, string | undefined>();

/**
 * The .env line of each boot-only key as the first load read it, undefined
 * when the file had no line for it. A reload reports a boot-only key only when
 * the value a relaunch would give it differs from the value boot gave it by
 * the same rule (this line, else the login shell's value), so a save that puts
 * the file back as boot read it is not reported. process.env cannot stand in
 * for it: the server publishes its bound port into ROUBO_PORT after boot.
 */
const bootOnlyBootLines = new Map<string, string | undefined>();

/**
 * The boot-only keys that were explicit env at the first load. Their .env line
 * would not apply after a relaunch either, so a reload never reports them.
 * The judgement is made at boot because the server publishes its bound port
 * into ROUBO_PORT after it, which would otherwise read as explicit env.
 */
const bootOnlyExplicit = new Set<string>();

/** What one load of $ROUBO_DIR/.env did. */
export interface EnvFileLoadReport {
  /** The keys whose process.env value the load changed. */
  changed: string[];
  /**
   * The boot-only keys whose line this load found changed, to a value that
   * differs both from the one boot gave the key and from the one the process
   * holds: they apply only after a relaunch. Always empty on the first load.
   */
  needsRelaunch: string[];
}

/**
 * Loads $ROUBO_DIR/.env and merges vars into process.env, and returns the keys
 * whose process.env value it changed. A process.env value from outside .env
 * and the login-shell import takes precedence (explicit env wins); a value the
 * login-shell import set does not. Silently no-ops if the file doesn't exist.
 *
 * Re-invocable (HR-FR-011): the state dir watch calls it again on each save of
 * .env, so a key added, changed or removed there reaches process.env, and so
 * every child process spawned after it, with no relaunch. A reload ends where a
 * relaunch would: .env overrides a key that holds the login shell's value, and
 * a key whose line is dropped goes back to the login shell's value, or is
 * removed when the shell has none. It changes no key that something else has
 * set since, and never the boot-only keys: `loadEnvFileReport()` also names
 * the boot-only keys a save changed, which need a relaunch.
 */
export function loadEnvFile(): string[] {
  return loadEnvFileReport().changed;
}

/**
 * `loadEnvFile()`, which also reports each boot-only key (`BOOT_ONLY_ENV_KEYS`)
 * that this load found changed and that only a relaunch would apply. A key is
 * reported when, on a reload, its .env line differs from the line the last
 * load read (a value changed, a line added or a line dropped), the key was not
 * explicit env at boot, and the value a relaunch would give it (the new line,
 * else the login shell's value, else none) differs both from the value boot
 * gave it by the same rule (the line the first load read, else the login
 * shell's value, else none) and from the one the process holds. So a save that
 * puts a line back as boot read it is not reported, and neither is a line that
 * matches the port the server bound. process.env is not changed for it.
 */
export function loadEnvFileReport(): EnvFileLoadReport {
  const first = !envFileLoaded;
  envFileLoaded = true;
  const values = readEnvFileValues();
  const changed: string[] = [];
  const needsRelaunch: string[] = [];
  for (const key of BOOT_ONLY_ENV_KEYS) {
    const line = values.get(key);
    const before = bootOnlyLines.get(key);
    bootOnlyLines.set(key, line);
    if (first) {
      bootOnlyBootLines.set(key, line);
      if (isExplicitEnv(key)) bootOnlyExplicit.add(key);
      continue;
    }
    if (line === before || bootOnlyExplicit.has(key)) continue;
    const shell = loginShellLayer.get(key);
    const relaunchValue = line ?? shell;
    const bootValue = bootOnlyBootLines.get(key) ?? shell;
    if (relaunchValue !== bootValue && relaunchValue !== process.env[key]) needsRelaunch.push(key);
  }
  for (const [key, value] of values) {
    if (!first && BOOT_ONLY_ENV_KEYS.has(key)) continue;
    if (isExplicitEnv(key)) {
      envFileApplied.delete(key);
      continue;
    }
    if (process.env[key] !== value) {
      process.env[key] = value;
      changed.push(key);
    }
    envFileApplied.set(key, value);
  }
  for (const key of [...envFileApplied.keys()]) {
    if (values.has(key)) continue;
    // A boot-only key stays as the first load set it, even when a save drops its line.
    if (!first && BOOT_ONLY_ENV_KEYS.has(key)) continue;
    if (ownedByEnvFile(key)) {
      const shell = loginShellLayer.get(key);
      if (shell === undefined) {
        Reflect.deleteProperty(process.env, key);
        changed.push(key);
      } else if (process.env[key] !== shell) {
        process.env[key] = shell;
        changed.push(key);
      }
    }
    envFileApplied.delete(key);
  }
  return { changed, needsRelaunch };
}

/**
 * The value of `key` now, read per call (HR-FR-011), with the precedence of a
 * relaunch: explicit env when the process has it from outside .env and the
 * login shell, else the line of $ROUBO_DIR/.env as the file holds it at this
 * call, else the login shell's value, else undefined. A save of .env is seen
 * by the next call even before the state dir watch has reloaded it.
 */
export function readEnvValue(key: string): string | undefined {
  if (isExplicitEnv(key)) return process.env[key];
  return readEnvFileValues().get(key) ?? loginShellLayer.get(key);
}

/** Forget what earlier loads of .env and the login-shell import applied. For tests. */
export function resetEnvFileLoads(): void {
  envFileApplied.clear();
  loginShellLayer.clear();
  bootOnlyLines.clear();
  bootOnlyBootLines.clear();
  bootOnlyExplicit.clear();
  envFileLoaded = false;
}
