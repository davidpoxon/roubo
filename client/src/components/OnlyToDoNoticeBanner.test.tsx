// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ONLY_TO_DO_NOTICE_MARKER } from "@roubo/shared";
import OnlyToDoNoticeBanner, { STORAGE_KEY_PREFIX } from "./OnlyToDoNoticeBanner";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  cleanup();
});

describe("OnlyToDoNoticeBanner (FR-018, issue #558)", () => {
  const AT = "2026-06-20T10:00:00.000Z";

  it("renders the changed-default copy and a link to the status filter for an existing install", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: 1,
      migration: null,
      notices: { [ONLY_TO_DO_NOTICE_MARKER]: AT },
    });

    render(<OnlyToDoNoticeBanner />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/now hides In Progress items by default/)).toBeTruthy(),
    );
    // role=status for WCAG (NFR-007).
    expect(screen.getByRole("status")).toBeTruthy();
    const link = screen.getByRole("link", { name: /status filter/i });
    expect(link.getAttribute("href")).toBe("/settings#plugins");
  });

  it("never shows on a fresh install (seeded sentinel marker)", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: 1,
      migration: null,
      notices: { [ONLY_TO_DO_NOTICE_MARKER]: "seeded" },
    });

    const { container } = render(<OnlyToDoNoticeBanner />, { wrapper: makeWrapper() });

    await waitFor(() => expect(mockedApi.fetchMigrationStatus).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the marker is absent", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: 1,
      migration: null,
      notices: {},
    });

    const { container } = render(<OnlyToDoNoticeBanner />, { wrapper: makeWrapper() });

    await waitFor(() => expect(mockedApi.fetchMigrationStatus).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("persists dismissal in localStorage and stays hidden across remounts", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: 1,
      migration: null,
      notices: { [ONLY_TO_DO_NOTICE_MARKER]: AT },
    });

    const { unmount } = render(<OnlyToDoNoticeBanner />, { wrapper: makeWrapper() });

    const dismiss = await screen.findByRole("button", { name: /dismiss cut list notice/i });
    fireEvent.click(dismiss);

    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}${ONLY_TO_DO_NOTICE_MARKER}:${AT}`)).toBe(
      "1",
    );
    expect(screen.queryByText(/now hides In Progress items by default/)).toBeNull();

    unmount();
    cleanup();

    render(<OnlyToDoNoticeBanner />, { wrapper: makeWrapper() });
    await waitFor(() => expect(mockedApi.fetchMigrationStatus).toHaveBeenCalled());
    expect(screen.queryByText(/now hides In Progress items by default/)).toBeNull();
  });
});
