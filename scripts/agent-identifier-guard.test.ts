import { describe, expect, it } from "vitest";

import { scanFiles } from "./agent-identifier-guard.mjs";

// Build a readFn over an in-memory file map so the scanner can be exercised
// without touching the real tree.
function scan(fileMap: Record<string, string>) {
  return scanFiles(Object.keys(fileMap), (f: string) => {
    if (!(f in fileMap)) throw new Error(`no such file: ${f}`);
    return fileMap[f];
  });
}

describe("scanFiles (AgentIdentifierGuard, AP-NFR-006, AP-TC-112)", () => {
  it("flags a reintroduced agent-specific function, naming the file and the identifier", () => {
    const findings = scan({
      "server/services/env.ts": [
        "export function getClaudeBinary(): string {", // line 1: violation
        '  return "claude";',
        "}",
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("server/services/env.ts");
    expect(findings[0].line).toBe(1);
    expect(findings[0].reason).toMatch(/agent-specific identifier 'getClaudeBinary'/);
  });

  it("flags an agent-specific type name in shared", () => {
    const findings = scan({
      "shared/types.ts": [
        "export interface ClaudeCodeSettings {", // line 1: violation
        "  enableAutoMode: boolean;",
        "}",
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].reason).toMatch(/ClaudeCodeSettings/);
  });

  it("flags an agent-specific property read", () => {
    const findings = scan({
      "server/routes/settings.ts": [
        "function read(settings) {",
        "  return settings.claudeCode;", // line 2: violation
        "}",
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
    expect(findings[0].reason).toMatch(/claudeCode/);
  });

  it("flags a second-agent identifier, not just the first agent's", () => {
    const findings = scan({
      "server/services/terminal.ts": ["const codexArgs = [];"].join("\n"), // line 1: violation
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/codexArgs/);
  });

  it("flags an identifier inside a template-literal interpolation", () => {
    const findings = scan({
      "server/services/terminal.ts": ["const msg = `binary: ${claudeBinary}`;"].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].reason).toMatch(/claudeBinary/);
  });

  it("flags an inline agent CLI flag assembled in core", () => {
    const findings = scan({
      "server/services/terminal.ts": [
        "const args = [];",
        '  if (autoMode) args.push("--enable-auto-mode");', // line 2: violation
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
    expect(findings[0].reason).toMatch(/inline agent CLI flag '--enable-auto-mode'/);
  });

  it("flags a second-agent CLI flag", () => {
    const findings = scan({
      "server/services/terminal.ts": ['args.push("--full-auto");'].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/--full-auto/);
  });

  it("does NOT flag an agent name inside a string literal (the install-path table)", () => {
    const findings = scan({
      "server/services/env.ts": [
        "export function wellKnownPathsFor(command: string): string[] {",
        "  switch (path.basename(command)) {",
        '    case "claude":',
        '      return [path.join(os.homedir(), ".claude", "local", "claude")];',
        "    default:",
        "      return [];",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag the published hook endpoint path or a legacy settings-file key", () => {
    const findings = scan({
      "server/routes/hooks.ts": ['router.post("/claude-notification", handler);'].join("\n"),
      "server/services/state.ts": ['const LEGACY_KEY = "claudeCode";'].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag agent names in a line comment", () => {
    const findings = scan({
      "server/services/terminal.ts": [
        "// The built-in getClaudeBinary path and its --enable-auto-mode flag are gone.",
        "const shell = getLoginShell();",
      ].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag agent names in a block comment, and keeps later line numbers correct", () => {
    const findings = scan({
      "server/services/terminal.ts": [
        "/*",
        " * ClaudeCodeSettings and --permission-mode are documented here only.",
        " */",
        "const claudeShell = 1;", // line 4: the only violation
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
    expect(findings[0].reason).toMatch(/claudeShell/);
  });

  it("returns no findings for clean core source", () => {
    const findings = scan({
      "server/services/terminal.ts": [
        "export function createSession(projectId: string): TerminalSession {",
        "  const shell = getLoginShell();",
        "  return spawn(shell, []);",
        "}",
      ].join("\n"),
      "shared/types.ts": ["export interface TerminalSession { id: string }"].join("\n"),
    });
    expect(findings).toEqual([]);
  });
});
