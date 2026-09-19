import { describe, it, expect } from "vitest";
import { agentDotClass, agentTextClass } from "./agent-color";

describe("agent-color", () => {
  it("seeds the two named agents onto swatches 1 and 2", () => {
    expect(agentDotClass("claude-code")).toBe("bg-agent-swatch-1");
    expect(agentTextClass("codex-cli")).toBe("text-agent-swatch-2");
  });

  it("hashes every other agent onto a per-theme swatch token, never a raw palette class", () => {
    for (const id of ["a", "bb", "ccc", "gemini-cli", "aider", "opencode", "x-agent"]) {
      expect(agentDotClass(id)).toMatch(/^bg-agent-swatch-[1-6]$/);
      expect(agentTextClass(id)).toMatch(/^text-agent-swatch-[1-6]$/);
    }
  });

  it("uses a quiet idle dot and secondary text for an unknown agent", () => {
    expect(agentDotClass(undefined)).toBe("bg-status-idle");
    expect(agentTextClass(undefined)).toBe("text-text-secondary");
  });
});
