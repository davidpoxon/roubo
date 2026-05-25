// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    startGithubPluginOauth: vi.fn(),
  },
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, startGithubPluginOauth: apiMocks.startGithubPluginOauth };
});

import OAuthReconsentDialog from "./OAuthReconsentDialog";

describe("OAuthReconsentDialog", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.fn>;
  let fireDeepLink: (url: string) => void = () => {};
  let unsubscribeSpy: ReturnType<typeof vi.fn>;
  let windowOpenSpy: ReturnType<typeof vi.fn>;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    apiMocks.startGithubPluginOauth.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidateSpy = vi.fn();
    queryClient.invalidateQueries = invalidateSpy as never;
    unsubscribeSpy = vi.fn();
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: {
        onDeepLink: vi.fn((cb: (url: string) => void) => {
          fireDeepLink = cb;
          return unsubscribeSpy;
        }),
        onNavigate: vi.fn(() => () => {}),
        platform: "darwin",
        setTitleBarOverlayTheme: vi.fn(),
        getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
      },
    });
    windowOpenSpy = vi.fn();
    vi.stubGlobal("open", windowOpenSpy);
  });

  afterEach(() => {
    Object.defineProperty(window, "roubo", { configurable: true, value: undefined });
    vi.unstubAllGlobals();
  });

  it("starts in idle state and announces readiness in the live region", () => {
    render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
        onCancelled={vi.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByTestId("oauth-reconsent-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("oauth-reconsent-live-region").textContent).toMatch(
      /ready to re-authorize/i,
    );
    expect(screen.getByRole("button", { name: /continue to github/i })).toBeInTheDocument();
  });

  it("advances to waiting-for-browser after Continue, opens the system browser, and announces it", async () => {
    apiMocks.startGithubPluginOauth.mockResolvedValueOnce({
      url: "https://github.com/login/oauth/authorize?state=xyz",
    });
    const user = userEvent.setup();
    render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
        onCancelled={vi.fn()}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole("button", { name: /continue to github/i }));

    await waitFor(() => {
      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?state=xyz",
        "_blank",
        "noopener,noreferrer",
      );
    });
    expect(await screen.findByText(/waiting for the github authorization/i)).toBeInTheDocument();
    expect(screen.getByTestId("oauth-reconsent-live-region").textContent).toMatch(/waiting/i);
    expect(screen.getByTestId("oauth-reconsent-cancel")).toBeInTheDocument();
  });

  it("transitions to success on a clean deep-link callback, invalidates caches, and calls onSuccess before closing", async () => {
    apiMocks.startGithubPluginOauth.mockResolvedValueOnce({
      url: "https://github.com/login/oauth/authorize?state=xyz",
    });
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={onSuccess}
        onCancelled={vi.fn()}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole("button", { name: /continue to github/i }));
    await waitFor(() => expect(windowOpenSpy).toHaveBeenCalled());

    act(() => {
      fireDeepLink("roubo://oauth/github/callback?code=abc&state=xyz");
    });

    expect(screen.getByText(/refreshing alerts/i)).toBeInTheDocument();
    expect(screen.getByTestId("oauth-reconsent-live-region").textContent).toMatch(
      /github authorized/i,
    );
    const keys = invalidateSpy.mock.calls.map((args) => args[0]?.queryKey);
    expect(keys).toEqual(expect.arrayContaining([["issues"], ["integration-warnings"]]));

    // Dialog holds the success state briefly, then calls onSuccess and closes.
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("transitions to error when the deep-link carries an ?error=access_denied param", async () => {
    apiMocks.startGithubPluginOauth.mockResolvedValueOnce({
      url: "https://github.com/login/oauth/authorize?state=xyz",
    });
    const user = userEvent.setup();
    render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
        onCancelled={vi.fn()}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole("button", { name: /continue to github/i }));
    await waitFor(() => expect(windowOpenSpy).toHaveBeenCalled());

    act(() => {
      fireDeepLink("roubo://oauth/github/callback?error=access_denied&state=xyz");
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/access was denied/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByTestId("oauth-reconsent-live-region").textContent).toMatch(
      /authorization failed/i,
    );
  });

  it("invokes onCancelled when the user clicks Cancel during waiting-for-browser", async () => {
    apiMocks.startGithubPluginOauth.mockResolvedValueOnce({
      url: "https://github.com/login/oauth/authorize?state=xyz",
    });
    const onCancelled = vi.fn();
    const user = userEvent.setup();
    render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
        onCancelled={onCancelled}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole("button", { name: /continue to github/i }));
    await waitFor(() => expect(screen.getByTestId("oauth-reconsent-cancel")).toBeInTheDocument());

    await user.click(screen.getByTestId("oauth-reconsent-cancel"));
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it("falls through to error state when startGithubPluginOauth rejects", async () => {
    apiMocks.startGithubPluginOauth.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
        onCancelled={vi.fn()}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole("button", { name: /continue to github/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/network down/i);
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it("unsubscribes from deep-link events on unmount", async () => {
    const { unmount } = render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
        onCancelled={vi.fn()}
      />,
      { wrapper },
    );
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });

  it("ignores deep-links unrelated to the GitHub OAuth callback", async () => {
    apiMocks.startGithubPluginOauth.mockResolvedValueOnce({
      url: "https://github.com/login/oauth/authorize?state=xyz",
    });
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={vi.fn()}
        onSuccess={onSuccess}
        onCancelled={vi.fn()}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole("button", { name: /continue to github/i }));
    await waitFor(() => expect(windowOpenSpy).toHaveBeenCalled());

    act(() => {
      fireDeepLink("roubo://project/proj-1/bench/bench-2");
    });

    // Still in waiting-for-browser; success was not triggered.
    expect(screen.getByText(/waiting for the github authorization/i)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
