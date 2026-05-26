import { describe, expect, it } from "vitest";
import { derivePluginConnectionState, primaryActionLabelFor } from "./derivePluginConnectionState";

describe("derivePluginConnectionState", () => {
  it('returns "disabled" for a disabled plugin regardless of config', () => {
    expect(derivePluginConnectionState("disabled")).toBe("disabled");
    expect(
      derivePluginConnectionState("disabled", {
        capturedUserId: { externalId: "1", displayName: "u" },
      }),
    ).toBe("disabled");
  });

  it('returns "errored" for the errored lifecycle status', () => {
    expect(derivePluginConnectionState("errored")).toBe("errored");
  });

  it('returns "errored" for the incompatible lifecycle status', () => {
    expect(derivePluginConnectionState("incompatible")).toBe("errored");
  });

  it('returns "errored" for the invalid lifecycle status', () => {
    expect(derivePluginConnectionState("invalid")).toBe("errored");
  });

  it('returns "disconnected" for an enabled plugin with no integration data yet', () => {
    expect(derivePluginConnectionState("enabled")).toBe("disconnected");
  });

  it('returns "disconnected" for an enabled plugin with empty effective config', () => {
    expect(derivePluginConnectionState("enabled", {})).toBe("disconnected");
  });

  it('returns "connected" when capturedUserId is present', () => {
    expect(
      derivePluginConnectionState("enabled", {
        capturedUserId: { externalId: "42", displayName: "Octocat" },
      }),
    ).toBe("connected");
  });

  it('returns "connected" for instance-based plugins once an instance URL is saved', () => {
    expect(derivePluginConnectionState("enabled", { instance: "https://ghe.example" })).toBe(
      "connected",
    );
  });

  it("ignores an empty-string instance", () => {
    expect(derivePluginConnectionState("enabled", { instance: "" })).toBe("disconnected");
  });

  it('treats a null status the same as "enabled" (for installed project-tile plugins before status loads)', () => {
    expect(derivePluginConnectionState(null)).toBe("disconnected");
    expect(
      derivePluginConnectionState(null, {
        capturedUserId: { externalId: "1", displayName: "u" },
      }),
    ).toBe("connected");
  });
});

describe("primaryActionLabelFor", () => {
  it.each([
    ["disabled", "Connect"],
    ["disconnected", "Connect"],
    ["connected", "Configure"],
    ["errored", "Configure"],
    ["auth-problem", "Sign in again"],
  ] as const)("%s -> %s", (state, label) => {
    expect(primaryActionLabelFor(state)).toBe(label);
  });
});
