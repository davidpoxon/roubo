// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LoginShellImportStatus } from "@roubo/shared";

vi.mock("../hooks/useSystemStatus");

import { useSystemStatus as _useSystemStatus } from "../hooks/useSystemStatus";
import SystemStatusBanner from "./SystemStatusBanner";

const useSystemStatus = vi.mocked(_useSystemStatus);

function withStatus(loginShellImport: LoginShellImportStatus | undefined): void {
  useSystemStatus.mockReturnValue({
    data: loginShellImport === undefined ? undefined : { loginShellImport },
  } as unknown as ReturnType<typeof _useSystemStatus>);
}

const TIMED_OUT: LoginShellImportStatus = {
  state: "failed",
  reason: "timeout",
  shell: "/bin/zsh",
  timeoutMs: 15_000,
  detail: "spawnSync /bin/zsh ETIMEDOUT",
};

describe("SystemStatusBanner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ["loading", undefined],
    ["ok", { state: "ok" }],
    ["not-run", { state: "not-run" }],
  ] as const)("renders nothing when the import is %s", (_label, status) => {
    withStatus(status);
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names a timed-out shell as the cause and a restart as the cure", () => {
    withStatus(TIMED_OUT);
    render(<SystemStatusBanner />);
    const banner = screen.getByRole("status", { name: "Shell environment not loaded" });
    expect(banner).toHaveTextContent("/bin/zsh did not start within 15 s");
    expect(banner).toHaveTextContent("running with a minimal PATH");
    expect(banner).toHaveTextContent("Quit and reopen Roubo");
    expect(banner).toHaveTextContent("spawnSync /bin/zsh ETIMEDOUT");
  });

  it("names a shell that could not be run", () => {
    withStatus({
      state: "failed",
      reason: "error",
      shell: "/bin/zsh",
      timeoutMs: 15_000,
      detail: "spawnSync /bin/zsh ENOENT",
    });
    render(<SystemStatusBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("/bin/zsh could not be run");
  });

  it("hides when dismissed", async () => {
    withStatus(TIMED_OUT);
    render(<SystemStatusBanner />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("login-shell-import-banner")).not.toBeInTheDocument();
  });
});
