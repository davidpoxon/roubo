import { describe, expect, it } from "vitest";

import { findAiCoauthorViolations } from "./check-ai-coauthorship.mjs";

function violationsFor(text: string) {
  return findAiCoauthorViolations([{ label: "test", text }]);
}

describe("findAiCoauthorViolations", () => {
  it("passes a clean commit message with no co-authors", () => {
    const message = ["fix(jig): truncate long chip labels", "", "Closes #389"].join("\n");
    expect(violationsFor(message)).toEqual([]);
  });

  it("passes a legitimate human Co-Authored-By line (the false-positive guard)", () => {
    const message = [
      "feat: pair-programmed change",
      "",
      "Co-Authored-By: Ada Lovelace <ada@example.com>",
    ].join("\n");
    expect(violationsFor(message)).toEqual([]);
  });

  it("fails an AI Co-Authored-By line (Claude)", () => {
    const message = ["feat: something", "", "Co-Authored-By: Claude <noreply@anthropic.com>"].join(
      "\n",
    );
    const found = violationsFor(message);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toMatch(/AI-agent co-author/);
  });

  it("fails on a range of AI-agent co-author identities", () => {
    const identities = [
      "Claude Code <noreply@anthropic.com>",
      "GitHub Copilot <copilot@github.com>",
      "Cursor <cursor@example.com>",
      "Codex <codex@openai.com>",
      "ChatGPT <noreply@openai.com>",
      "GPT-4 <gpt@openai.com>",
      "Gemini <gemini@google.com>",
      "Devin <devin@cognition.ai>",
    ];
    for (const identity of identities) {
      const message = `feat: x\n\nCo-Authored-By: ${identity}`;
      expect(violationsFor(message), identity).toHaveLength(1);
    }
  });

  it("matches an AI co-author via the email even when the name looks human", () => {
    const message = "feat: x\n\nCo-Authored-By: Helper Bot <noreply@anthropic.com>";
    expect(violationsFor(message)).toHaveLength(1);
  });

  it("fails the robot-emoji attribution footer", () => {
    const message = "feat: x\n\n🤖 Generated with Claude Code";
    const found = violationsFor(message);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.some((v) => v.reason.includes("footer"))).toBe(true);
  });

  it("fails a 'Generated with [Claude Code]' footer", () => {
    const message = "feat: x\n\nGenerated with [Claude Code](https://claude.com/claude-code)";
    expect(violationsFor(message)).not.toHaveLength(0);
  });

  it("fails a noreply@anthropic.com co-author footer", () => {
    const message = "feat: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>";
    expect(violationsFor(message)).toHaveLength(1);
  });

  it("scans the PR body surface and reports its label", () => {
    const sources = [
      { label: "commit abc1234 (feat: x)", text: "feat: x\n\nCloses #1" },
      { label: "PR body", text: "This PR does things.\n\n🤖 Generated with Claude Code" },
    ];
    const found = findAiCoauthorViolations(sources);
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("PR body");
  });

  it("returns no violations for a non-array input", () => {
    // @ts-expect-error exercising the defensive guard
    expect(findAiCoauthorViolations(undefined)).toEqual([]);
    // @ts-expect-error exercising the defensive guard
    expect(findAiCoauthorViolations(null)).toEqual([]);
  });

  it("ignores sources whose text is not a string", () => {
    // @ts-expect-error exercising the defensive guard
    expect(findAiCoauthorViolations([{ label: "x", text: 42 }, null])).toEqual([]);
  });
});
