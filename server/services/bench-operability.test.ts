import { describe, it, expect } from "vitest";
import {
  isBenchOperable,
  benchNotOperableMessage,
  assertBenchOperable,
} from "./bench-operability.js";
import { ServiceError } from "./service-error.js";

describe("isBenchOperable", () => {
  it("is true for a bench with a non-empty workspacePath", () => {
    expect(isBenchOperable({ workspacePath: "/home/.roubo/workspaces/p/bench-1" })).toBe(true);
  });

  it("is false for a bench whose workspacePath was blanked (allowlist-rejected)", () => {
    expect(isBenchOperable({ workspacePath: "" })).toBe(false);
  });
});

describe("benchNotOperableMessage", () => {
  it("always mentions the missing workspace path and the clear remedy", () => {
    expect(benchNotOperableMessage()).toBe("Bench has no valid workspace path; clear it instead.");
    expect(benchNotOperableMessage()).toMatch(/no valid workspace path/i);
  });

  it("embeds the action verb phrase when one is supplied", () => {
    expect(benchNotOperableMessage("be inspected")).toBe(
      "Bench has no valid workspace path and cannot be inspected; clear it instead.",
    );
  });
});

describe("assertBenchOperable", () => {
  it("does not throw for an operable bench", () => {
    expect(() =>
      assertBenchOperable({ workspacePath: "/home/.roubo/workspaces/p/bench-1" }),
    ).not.toThrow();
  });

  it("throws ServiceError(400) for a non-operable bench", () => {
    let thrown: unknown;
    try {
      assertBenchOperable({ workspacePath: "" }, "be assigned an issue");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).statusCode).toBe(400);
    expect((thrown as ServiceError).message).toBe(
      "Bench has no valid workspace path and cannot be assigned an issue; clear it instead.",
    );
  });
});
