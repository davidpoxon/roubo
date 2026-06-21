import { describe, expect, it } from "vitest";

import { scanFiles } from "./component-type-knowledge-guard.mjs";

// Build a readFn over an in-memory file map so the scanner can be exercised
// without touching the real tree.
function scan(fileMap: Record<string, string>) {
  return scanFiles(Object.keys(fileMap), (f: string) => {
    if (!(f in fileMap)) throw new Error(`no such file: ${f}`);
    return fileMap[f];
  });
}

describe("scanFiles (ComponentTypeKnowledgeGuard, CP-NFR-006)", () => {
  it("flags a reintroduced component-type equality literal with file and line", () => {
    const findings = scan({
      "server/services/bench-manager.ts": [
        "function dispatch(component) {",
        "  if (component.type === 'database') {", // line 2: violation
        "    return startDatabase();",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("server/services/bench-manager.ts");
    expect(findings[0].line).toBe(2);
    expect(findings[0].reason).toMatch(/component-type literal/);
  });

  it("flags a reintroduced `case 'process':` dispatch in a non-engine module", () => {
    const findings = scan({
      "server/services/bench-manager.ts": [
        "switch (component.type) {",
        "  case 'process':", // line 2: violation
        "    return startProcess();",
        "}",
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
    expect(findings[0].reason).toMatch(/component-type literal/);
  });

  it("flags a core docker/compose field read outside the owning modules", () => {
    const findings = scan({
      "server/routes/benches.ts": [
        "function describe(config) {",
        "  return config.composeFile;", // line 2: violation
        "}",
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("server/routes/benches.ts");
    expect(findings[0].line).toBe(2);
    expect(findings[0].reason).toMatch(/docker\/compose field/);
  });

  it("does NOT flag docker fields inside an allowlisted owning module", () => {
    const findings = scan({
      "server/services/lifecycle-engine.ts": [
        "const up = await docker.composeUp({",
        "  composeFile: descriptor.composeFile,", // allowlisted module
        "  initService: descriptor.initService,",
        "});",
      ].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag bench-manager reading the plugin's cached descriptor", () => {
    // Post-#612, bench-manager reads the descriptor (the plugin's typed output)
    // to down compose projects on teardown; that is not a config docker-field.
    const findings = scan({
      "server/services/bench-manager.ts": [
        "if (descriptor?.kind === 'docker') {",
        "  await dockerService.composeDown(name, descriptor.composeFile, cwd);",
        "}",
      ].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag the descriptor-kind switch in the lifecycle engine", () => {
    const findings = scan({
      "server/services/lifecycle-engine.ts": [
        "switch (descriptor.kind) {",
        "  case 'docker':",
        "    return runDocker();",
        "  case 'process':", // engine's own descriptor-kind tag, allowlisted
        "    return runProcess();",
        "}",
      ].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag prose in comments that documents the forbidden patterns", () => {
    const findings = scan({
      "server/services/bench-manager.ts": [
        '// NFR-006 forbids `=== "database"` / `=== "process"` dispatch and',
        "// reading a config docker-field like componentConfig.composeFile.",
        "/*",
        " * No core `type === 'database'` guard; the case 'process': dispatch is gone.",
        " */",
        "const descriptors = new Map();",
      ].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT flag a docker-field name in a comment in a non-allowlisted core file", () => {
    // server/routes/benches.ts is NOT docker-field-allowlisted, so rule 2 runs
    // against it. A docker-field name appearing only in a comment must not be a
    // violation: rule 2 strips comments before matching, like rule 1.
    const findings = scan({
      "server/routes/benches.ts": [
        "function listBenches(req, res) {",
        "  // the plugin descriptor (not config) owns .composeFile / .initService",
        "  return res.json(benches);",
        "}",
      ].join("\n"),
    });
    expect(findings).toEqual([]);
  });

  it("returns zero findings on clean input", () => {
    const findings = scan({
      "server/routes/benches.ts": [
        "function listBenches(req, res) {",
        "  return res.json(benches);",
        "}",
      ].join("\n"),
      "shared/types.ts": "export interface Bench { id: number; }",
    });
    expect(findings).toEqual([]);
  });
});
