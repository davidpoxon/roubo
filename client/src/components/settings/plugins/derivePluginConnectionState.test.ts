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

describe("derivePluginConnectionState: live ConnectionStatus precedence (issue #204)", () => {
  it('prefers a live "auth-problem" over the derive-from-config connected path', () => {
    expect(
      derivePluginConnectionState(
        "enabled",
        { capturedUserId: { externalId: "42", displayName: "Octocat" } },
        { state: "auth-problem", detail: "Token expired" },
      ),
    ).toBe("auth-problem");
  });

  it('prefers a live "errored" over the derive-from-config disconnected fallback', () => {
    expect(derivePluginConnectionState("enabled", {}, { state: "errored" })).toBe("errored");
  });

  it('prefers a live "connected" even when no captured user is in the effective config', () => {
    expect(derivePluginConnectionState("enabled", undefined, { state: "connected" })).toBe(
      "connected",
    );
  });

  it("treats a null lifecycle status the same as enabled when live data is present", () => {
    expect(derivePluginConnectionState(null, undefined, { state: "auth-problem" })).toBe(
      "auth-problem",
    );
  });

  it('ignores live data when lifecycle status is "disabled"', () => {
    expect(derivePluginConnectionState("disabled", undefined, { state: "connected" })).toBe(
      "disabled",
    );
  });

  it.each(["errored", "incompatible", "invalid"] as const)(
    'ignores live data when lifecycle status is "%s"',
    (status) => {
      expect(derivePluginConnectionState(status, undefined, { state: "connected" })).toBe(
        "errored",
      );
    },
  );

  it("falls back to derive-from-config when live is undefined", () => {
    expect(
      derivePluginConnectionState(
        "enabled",
        { capturedUserId: { externalId: "1", displayName: "u" } },
        undefined,
      ),
    ).toBe("connected");
  });

  it("falls back to derive-from-config when live is null", () => {
    expect(derivePluginConnectionState("enabled", {}, null)).toBe("disconnected");
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
