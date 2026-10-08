import { spawn } from "node:child_process";
import { cleanEnv } from "./env.js";

/** Splits a command string into arguments, respecting single and double quotes.
 *  Backslash-escaped quotes inside quoted strings (e.g. "arg with \" quote") are not supported. */
export function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of command) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/** Shell invocations accepted for a descriptor's `shell` string: either an
 *  absolute path (`/bin/zsh`) or a bare command name resolved through PATH
 *  (`zsh`), of safe characters only. This widens env.ts's SAFE_SHELL_PATH_RE by
 *  the unqualified-basename case, and is the same barrier CodeQL's
 *  js/command-line-injection suite recognises as a sanitizer at the spawn site
 *  (see code-scanning alert #106). */
const SAFE_SHELL_RE = /^(?:\/[\w./-]+|[\w.-]+)$/;

/**
 * Resolves how a configured command line is spawned (#1218).
 *
 * Commands in `roubo.yaml` are ARGV BY DEFAULT: `parseCommand` tokenizes the
 * string and the first token is the executable, so `&&`, `;`, globs and `$VAR`
 * are literal arguments and a shell function such as `nvm` never resolves.
 * `shell` is the opt-in that changes that, in either of two forms:
 *
 * - `true`: run through `/bin/sh -c <command>`. Operators, redirection, globs
 *   and `$VAR` work. The shell is neither interactive nor login, so it sources
 *   no rc file and rc-defined functions (nvm, fnm, asdf) stay invisible.
 * - a string: the shell invocation the command is appended to as `-c`, so
 *   `zsh -i` spawns `zsh -i -c <command>`. This is the only form that can reach
 *   an INTERACTIVE shell, and therefore the only one that makes an
 *   nvm-in-`.zshrc` setup work.
 *
 * Omitting `shell` (or setting it `false`) leaves today's argv behaviour
 * byte-identical. An empty command yields an empty `file`; callers own the
 * "command is empty" error so each keeps its own wording.
 */
export function resolveSpawn(
  command: string,
  shell?: boolean | string,
): { file: string; args: string[] } {
  if (shell === undefined || shell === false) {
    const parts = parseCommand(command);
    return { file: parts[0] ?? "", args: parts.slice(1) };
  }

  if (shell === true) {
    return { file: "/bin/sh", args: ["-c", command] };
  }

  const shellParts = parseCommand(shell);
  const file = shellParts[0];
  if (!file) {
    throw new Error("shell is empty: expected a shell invocation such as 'zsh -i'");
  }
  if (!SAFE_SHELL_RE.test(file)) {
    throw new Error(
      `shell '${file}' is not a usable shell: expected an absolute path (/bin/zsh) or a bare command name (zsh).`,
    );
  }
  return { file, args: [...shellParts.slice(1), "-c", command] };
}

/** Shell-significant characters that are inert in argv mode. Used to explain a
 *  failed argv-mode spawn in terms of the missing shell (#1218). */
const SHELL_METACHARACTER_RE = /[&|;<>$`*?(){}[\]~\n]|^cd\s/;

/**
 * Explains an argv-mode spawn failure when the command carries shell syntax
 * that argv mode cannot honour (#1218, AC7). Returns undefined when the command
 * holds no shell metacharacter, so an ordinary typo keeps its ordinary error.
 */
export function shellHintForCommand(command: string): string | undefined {
  const match = SHELL_METACHARACTER_RE.exec(command);
  if (!match) return undefined;
  const found = match[0].trim();
  return (
    `The command contains '${found}', which is shell syntax. Commands run as argv by default, ` +
    `so it was passed through as a literal argument rather than interpreted. ` +
    `Add 'shell: true' to run it through /bin/sh, or 'shell: zsh -i' to run it through an ` +
    `interactive shell (needed for rc-defined tools such as nvm).`
  );
}

/** Time an aborted command gets to exit on SIGTERM before it is sent SIGKILL. */
const ABORT_KILL_GRACE_MS = 5000;

export interface RunCommandOptions {
  /**
   * Aborting kills the command and everything it spawned (#1433). A command
   * such as `git submodule update` runs its work in child processes (`git
   * clone`, `index-pack`), so on POSIX the command is started in its own
   * process group and the whole group is signalled. The returned promise still
   * resolves only once the command has exited, so a caller that awaits it can
   * remove the command's working directory without racing a live writer.
   */
  signal?: AbortSignal;
  /**
   * Kills the command, and everything it spawned, once it has written nothing
   * to stdout or stderr for this long (#1438). Unlike `timeoutMs`, a command
   * that keeps reporting progress runs for as long as it needs, so a long
   * network transfer is stopped only when it stalls. Like an abort, this starts
   * the command in its own process group on POSIX.
   */
  idleTimeoutMs?: number;
}

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Present and `true` only when the command was stopped by its abort signal. */
  aborted?: boolean;
  /** Present and `true` only when the command was stopped by `idleTimeoutMs`. */
  idleTimedOut?: boolean;
}

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs?: number,
  stdin?: string,
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const { signal, idleTimeoutMs } = options;
  const idleLimited = idleTimeoutMs !== undefined && idleTimeoutMs > 0;
  if (signal?.aborted) {
    return Promise.resolve({ code: 1, stdout: "", stderr: "Aborted", aborted: true });
  }
  // Callers are responsible for passing a sanitised cwd (via
  // state.getWorkspacePath / resolveWithin / project registry paths). We
  // intentionally avoid path.resolve(cwd) here: it would turn a tainted
  // value into a new path expression that CodeQL flags at the spawn site
  // (js/path-injection) without actually narrowing the trust boundary.
  return new Promise((resolve) => {
    // A new process group lets an abort or an idle kill reach the command's own
    // children. Only then, so every other caller's spawn stays exactly as before.
    const ownGroup = (signal !== undefined || idleLimited) && process.platform !== "win32";
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...cleanEnv(), ...env },
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      ...(signal !== undefined || idleLimited ? { detached: ownGroup } : {}),
    });

    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (ownGroup && proc.pid !== undefined) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        // The group already exited between the abort and the kill.
      }
    };
    const stopGroup = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), ABORT_KILL_GRACE_MS);
    };
    const onAbort = () => {
      aborted = true;
      stopGroup();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (!idleLimited || idleTimedOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        stopGroup();
      }, idleTimeoutMs);
    };
    armIdleTimer();

    const settle = (result: RunCommandResult) => {
      if (killTimer) clearTimeout(killTimer);
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        ...result,
        ...(aborted ? { aborted: true } : {}),
        ...(idleTimedOut ? { idleTimedOut: true } : {}),
      });
    };

    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // The whole group, as for an abort: a child that holds the output pipes
        // open would otherwise keep 'close' from ever firing.
        signalGroup("SIGTERM");
      }, timeoutMs);
    }

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      settle({ code: 1, stdout, stderr: stderr + err.message });
    });
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
      armIdleTimer();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
      armIdleTimer();
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        stderr += `\nProcess timed out after ${timeoutMs}ms`;
      }
      if (idleTimedOut) {
        stderr += `\nProcess produced no output for ${idleTimeoutMs}ms`;
      }
      settle({ code: code ?? 1, stdout, stderr });
    });
  });
}
