// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GitHubErrorState from "./GitHubErrorState";
import { ApiError } from "../lib/api";

const mockConnectMutate = vi.fn();
const mockDisconnectMutate = vi.fn();

vi.mock("../hooks/useGitHubAuth", () => ({
  useConnectGitHub: () => ({ mutate: mockConnectMutate, isPending: false }),
  useDisconnectGitHub: () => ({ mutate: mockDisconnectMutate, isPending: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeApiError(
  code: string,
  message = "Error",
  params: Record<string, string> = {},
): ApiError {
  return new ApiError(message, 403, code, { error: message, code, params });
}

describe("GitHubErrorState", () => {
  it("renders nothing when error is falsy", () => {
    const { container } = render(<GitHubErrorState error={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when error is undefined", () => {
    const { container } = render(<GitHubErrorState error={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("NOT_CONNECTED: shows title and Connect GitHub button", () => {
    render(<GitHubErrorState error={makeApiError("NOT_CONNECTED", "GitHub not connected")} />);
    expect(screen.getByText("GitHub not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect github/i })).toBeTruthy();
  });

  it("NOT_CONNECTED: Connect GitHub calls connectGitHub.mutate", async () => {
    render(<GitHubErrorState error={makeApiError("NOT_CONNECTED")} />);
    await userEvent.click(screen.getByRole("button", { name: /connect github/i }));
    expect(mockConnectMutate).toHaveBeenCalledTimes(1);
  });

  it("SCOPES_OUTDATED: shows Reconnect GitHub button", () => {
    render(<GitHubErrorState error={makeApiError("SCOPES_OUTDATED")} />);
    expect(screen.getByText("Permissions out of date")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reconnect github/i })).toBeTruthy();
  });

  it("SCOPES_OUTDATED: Reconnect calls disconnect then connect", async () => {
    render(<GitHubErrorState error={makeApiError("SCOPES_OUTDATED")} />);
    await userEvent.click(screen.getByRole("button", { name: /reconnect github/i }));
    expect(mockDisconnectMutate).toHaveBeenCalledTimes(1);
  });

  it("ORG_APPROVAL_REQUIRED: shows owner in description and approval link", () => {
    render(
      <GitHubErrorState
        error={makeApiError("ORG_APPROVAL_REQUIRED", "needs approval", { owner: "acme" })}
      />,
    );
    expect(screen.getByText("Org approval required")).toBeTruthy();
    expect(screen.getByText(/acme/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /request approval/i });
    expect(link.getAttribute("href")).toContain("acme");
  });

  it("SAML_SSO_REQUIRED: shows SSO link with owner", () => {
    render(
      <GitHubErrorState
        error={makeApiError("SAML_SSO_REQUIRED", "SAML required", { owner: "myorg" })}
      />,
    );
    expect(screen.getByText("SAML SSO authorization required")).toBeTruthy();
    const link = screen.getByRole("link", { name: /authorize sso/i });
    expect(link.getAttribute("href")).toContain("myorg");
  });

  it("OWNER_NOT_FOUND: shows title with retry action when onRetry provided", () => {
    const onRetry = vi.fn();
    render(<GitHubErrorState error={makeApiError("OWNER_NOT_FOUND")} onRetry={onRetry} />);
    expect(screen.getByText("Owner not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("RATE_LIMITED: shows rate limited title", () => {
    render(
      <GitHubErrorState
        error={makeApiError("RATE_LIMITED", "rate limit", { retryAfterSec: "60" })}
      />,
    );
    expect(screen.getByText("Rate limited by GitHub")).toBeTruthy();
    expect(screen.getByText(/60s/)).toBeTruthy();
  });

  it("NETWORK: shows network title and Retry button", () => {
    const onRetry = vi.fn();
    render(<GitHubErrorState error={makeApiError("NETWORK")} onRetry={onRetry} />);
    expect(screen.getByText("Can't reach GitHub")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("NETWORK: Retry calls onRetry", async () => {
    const onRetry = vi.fn();
    render(<GitHubErrorState error={makeApiError("NETWORK")} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("UNKNOWN: shows generic title with error message", () => {
    render(<GitHubErrorState error={makeApiError("UNKNOWN", "something unexpected")} />);
    expect(screen.getByText("Could not load from GitHub")).toBeTruthy();
  });

  it("non-ApiError: shows generic title", () => {
    render(<GitHubErrorState error={new Error("network timeout")} />);
    expect(screen.getByText("Could not load from GitHub")).toBeTruthy();
  });

  it("banner variant: renders with amber background class", () => {
    const { container } = render(
      <GitHubErrorState error={makeApiError("NOT_CONNECTED")} variant="banner" />,
    );
    expect(container.querySelector('.bg-amber-50, [class*="amber-50"]')).toBeTruthy();
  });

  it("inline variant (default): does not use banner amber background", () => {
    const { container } = render(<GitHubErrorState error={makeApiError("OWNER_NOT_FOUND")} />);
    expect(container.querySelector(".bg-amber-50")).toBeNull();
  });

  it("ORG_APPROVAL_REQUIRED without owner: renders title but no action link", () => {
    render(<GitHubErrorState error={makeApiError("ORG_APPROVAL_REQUIRED")} />);
    expect(screen.getByText("Org approval required")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /request approval/i })).toBeNull();
  });

  it("SAML_SSO_REQUIRED without owner: renders title but no action link", () => {
    render(<GitHubErrorState error={makeApiError("SAML_SSO_REQUIRED")} />);
    expect(screen.getByText("SAML SSO authorization required")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /authorize sso/i })).toBeNull();
  });

  it("SCOPES_OUTDATED: shows error message when disconnect fails", async () => {
    mockDisconnectMutate.mockImplementation((_: unknown, opts?: { onError?: () => void }) => {
      opts?.onError?.();
    });
    render(<GitHubErrorState error={makeApiError("SCOPES_OUTDATED")} />);
    await userEvent.click(screen.getByRole("button", { name: /reconnect github/i }));
    expect(screen.getByText(/could not disconnect/i)).toBeTruthy();
  });

  it("SCOPES_OUTDATED: shows error message when connect step fails after successful disconnect", async () => {
    mockDisconnectMutate.mockImplementation((_: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    mockConnectMutate.mockImplementation((_: unknown, opts?: { onError?: () => void }) => {
      opts?.onError?.();
    });
    render(<GitHubErrorState error={makeApiError("SCOPES_OUTDATED")} />);
    await userEvent.click(screen.getByRole("button", { name: /reconnect github/i }));
    expect(screen.getByText(/could not connect/i)).toBeTruthy();
  });
});
