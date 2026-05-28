// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GitHubErrorState from "./GitHubErrorState";
import { ApiError } from "../lib/api";

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

  it("NOT_CONNECTED: shows title and Connect GitHub button when onReconnect provided", () => {
    render(
      <GitHubErrorState
        error={makeApiError("NOT_CONNECTED", "GitHub not connected")}
        onReconnect={() => {}}
      />,
    );
    expect(screen.getByText("GitHub not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect github/i })).toBeTruthy();
  });

  it("NOT_CONNECTED: Connect GitHub invokes onReconnect", async () => {
    const onReconnect = vi.fn();
    render(<GitHubErrorState error={makeApiError("NOT_CONNECTED")} onReconnect={onReconnect} />);
    await userEvent.click(screen.getByRole("button", { name: /connect github/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("NOT_CONNECTED without onReconnect: omits the action button", () => {
    render(<GitHubErrorState error={makeApiError("NOT_CONNECTED")} />);
    expect(screen.getByText("GitHub not connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect github/i })).toBeNull();
  });

  it("SCOPES_OUTDATED: shows Reconnect GitHub button when onReconnect provided", () => {
    render(<GitHubErrorState error={makeApiError("SCOPES_OUTDATED")} onReconnect={() => {}} />);
    expect(screen.getByText("Permissions out of date")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reconnect github/i })).toBeTruthy();
  });

  it("SCOPES_OUTDATED: Reconnect invokes onReconnect", async () => {
    const onReconnect = vi.fn();
    render(<GitHubErrorState error={makeApiError("SCOPES_OUTDATED")} onReconnect={onReconnect} />);
    await userEvent.click(screen.getByRole("button", { name: /reconnect github/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
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
      <GitHubErrorState
        error={makeApiError("NOT_CONNECTED")}
        onReconnect={() => {}}
        variant="banner"
      />,
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

  it("rpc-error: surfaces the plugin's actual message, not the code", () => {
    const onRetry = vi.fn();
    render(
      <GitHubErrorState
        error={makeApiError("rpc-error", "GitHub responded 401 Bad credentials")}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Plugin error")).toBeTruthy();
    expect(screen.getByText("GitHub responded 401 Bad credentials")).toBeTruthy();
    expect(screen.queryByText("rpc-error")).toBeNull();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("rpc-init-failed: shows plugin-start title with the underlying message", () => {
    render(
      <GitHubErrorState
        error={makeApiError("rpc-init-failed", "plugin process exited during init")}
      />,
    );
    expect(screen.getByText("Plugin failed to start")).toBeTruthy();
    expect(screen.getByText("plugin process exited during init")).toBeTruthy();
  });

  it("plugin-not-enabled: shows integration-not-available title and Configure button", () => {
    render(<GitHubErrorState error={makeApiError("plugin-not-enabled")} onReconnect={() => {}} />);
    expect(screen.getByText("Integration not available")).toBeTruthy();
    expect(screen.getByRole("button", { name: /configure/i })).toBeTruthy();
  });

  it("unknown-plugin: shares the integration-not-available copy", () => {
    render(<GitHubErrorState error={makeApiError("unknown-plugin")} onReconnect={() => {}} />);
    expect(screen.getByText("Integration not available")).toBeTruthy();
    expect(screen.getByRole("button", { name: /configure/i })).toBeTruthy();
  });

  it("timeout: shows timed-out title with the underlying message", () => {
    render(<GitHubErrorState error={makeApiError("timeout", "request exceeded 30s")} />);
    expect(screen.getByText("Plugin timed out")).toBeTruthy();
    expect(screen.getByText("request exceeded 30s")).toBeTruthy();
  });
});
