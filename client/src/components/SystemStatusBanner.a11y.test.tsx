// @vitest-environment jsdom
//
// The login-shell import banner (#1487) is an attention band a keyboard-only
// user must be able to read and dismiss.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { expectNoAxeFindings } from "../test/axe";

vi.mock("../hooks/useSystemStatus");

import { useSystemStatus as _useSystemStatus } from "../hooks/useSystemStatus";
import SystemStatusBanner from "./SystemStatusBanner";

describe("SystemStatusBanner a11y", () => {
  it("has no axe findings and exposes a named status with a dismiss button", async () => {
    vi.mocked(_useSystemStatus).mockReturnValue({
      data: {
        loginShellImport: {
          state: "failed",
          reason: "timeout",
          shell: "/bin/zsh",
          timeoutMs: 15_000,
          detail: "spawnSync /bin/zsh ETIMEDOUT",
        },
      },
    } as unknown as ReturnType<typeof _useSystemStatus>);
    const { baseElement } = render(<SystemStatusBanner />);
    expect(screen.getByRole("status", { name: "Shell environment not loaded" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeVisible();
    expectNoAxeFindings(await axe(baseElement));
  });
});
