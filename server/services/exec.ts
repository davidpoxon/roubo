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
 * Resolves how a configured command line is spawned (#836).
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
 *  failed argv-mode spawn in terms of the missing shell (#836). */
const SHELL_METACHARACTER_RE = /[&|;<>$`*?(){}[\]~\n]|^cd\s/;

/**
 * Explains an argv-mode spawn failure when the command carries shell syntax
 * that argv mode cannot honour (#836, AC7). Returns undefined when the command
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

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs?: number,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Callers are responsible for passing a sanitised cwd (via
  // state.getWorkspacePath / resolveWithin / project registry paths). We
  // intentionally avoid path.resolve(cwd) here: it would turn a tainted
  // value into a new path expression that CodeQL flags at the spawn site
  // (js/path-injection) without actually narrowing the trust boundary.
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...cleanEnv(), ...env },
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

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
        proc.kill("SIGTERM");
      }, timeoutMs);
    }

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + err.message });
    });
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        stderr += `\nProcess timed out after ${timeoutMs}ms`;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
