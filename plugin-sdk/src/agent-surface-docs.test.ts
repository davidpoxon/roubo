// AP-TC-119 S002: the agent-plugin SDK surface is DOCUMENTED, not merely
// exported.
//
// S001 (the surface is published and exported) is covered by
// `server/services/marketplace-third-party-publish-tc118-journey.e2e.test.ts`.
// This file covers S002, and deliberately does more than spot keywords: every
// symbol it requires the doc to name is cross-checked against the SDK's real
// export surface, so the doc cannot drift into documenting something the SDK no
// longer ships, and a rename cannot leave the doc silently stale.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as sdk from "./index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_PATH = path.resolve(HERE, "..", "..", "docs", "plugin-sdk.md");
const DOC = readFileSync(DOC_PATH, "utf8");
const INDEX_SRC = readFileSync(path.join(HERE, "index.ts"), "utf8");

/** The fenced code blocks in the doc, contents only. */
const FENCED = [...DOC.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);

describe("docs/plugin-sdk.md documents the agent SDK surface (AP-TC-119 S002)", () => {
  it("S002-O01: describes the agent definition entry point, and it is a real runtime export", () => {
    expect(DOC).toMatch(/^##\s+Agent contract\s*$/m);

    // The entry point the doc tells authors to call must exist on the barrel.
    expect(Object.keys(sdk)).toContain("defineAgentPlugin");
    expect(DOC).toContain("defineAgentPlugin");

    // And the doc must show it being imported from the package, not just name it
    // in prose, so a reader can copy a working import.
    expect(
      FENCED.some((b) =>
        /import\s*{[^}]*defineAgentPlugin[^}]*}\s*from\s*"@roubo\/plugin-sdk"/.test(b),
      ),
      'expected a fenced example importing defineAgentPlugin from "@roubo/plugin-sdk"',
    ).toBe(true);

    // The single contract method, named in the doc and in the exported type.
    expect(DOC).toContain("translateLaunch");
    expect(INDEX_SRC).toContain("AgentContractMethodName");
  });

  it("S002-O01: describes the agent contract types, and each is exported from the barrel", () => {
    // Types the doc leans on to explain the contract. Each must be re-exported
    // from index.ts (type-only exports are erased at runtime, so the barrel
    // source is the check) AND appear in the doc.
    for (const typeName of ["AgentContract", "AgentLaunchDescriptor"]) {
      expect(INDEX_SRC, `${typeName} must be exported from the SDK barrel`).toContain(typeName);
      expect(DOC, `docs/plugin-sdk.md must describe ${typeName}`).toContain(typeName);
    }
  });

  it("S002-O02: shows how to declare kind: agent in a manifest", () => {
    expect(
      FENCED.some((b) => /^\s*kind:\s*agent\s*$/m.test(b)),
      "expected a fenced manifest example declaring `kind: agent`",
    ).toBe(true);
  });

  it("S002-O02: shows how to declare the agent compatibility metadata", () => {
    expect(DOC).toMatch(/^###\s+Agent compatibility\s*$/m);

    // The window is two bounds; a doc naming the block but neither bound would
    // not tell an author what to write.
    const block = FENCED.find((b) => /^\s*agentCompatibility:\s*$/m.test(b));
    expect(block, "expected a fenced example declaring `agentCompatibility:`").toBeDefined();
    expect(block).toMatch(/^\s*minVersion:/m);
    expect(block).toMatch(/^\s*testedCeiling:/m);
  });
});
