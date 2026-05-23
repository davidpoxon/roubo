// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import MigrationBanner, { STORAGE_KEY_PREFIX } from "./MigrationBanner";

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

describe("MigrationBanner — success variant", () => {
  it("renders the success copy and Learn more link", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: 1,
      migration: {
        status: "success",
        at: "2026-05-23T10:00:00.000Z",
        migratedProjectIds: ["alpha"],
      },
    });

    render(<MigrationBanner />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(
        screen.getByText(/Roubo now manages GitHub integration through a plugin/),
      ).toBeTruthy(),
    );

    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link.getAttribute("href")).toMatch(/prd\.md$/);
  });

  it("persists dismissal in localStorage and stays hidden across remounts", async () => {
    const at = "2026-05-23T10:00:00.000Z";
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: 1,
      migration: { status: "success", at, migratedProjectIds: [] },
    });

    const { unmount } = render(<MigrationBanner />, { wrapper: makeWrapper() });

    const dismiss = await screen.findByRole("button", {
      name: /dismiss migration banner/i,
    });
    fireEvent.click(dismiss);

    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}${at}`)).toBe("1");
    expect(screen.queryByText(/Roubo now manages GitHub integration/)).toBeNull();

    unmount();
    cleanup();

    render(<MigrationBanner />, { wrapper: makeWrapper() });
    // Even after the query resolves, the banner must not appear because the
    // dismissal marker is set in localStorage.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/Roubo now manages GitHub integration/)).toBeNull();
  });
});

describe("MigrationBanner — rolled-back variant", () => {
  it("renders the red-tinted copy with a link to /settings#plugins", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: null,
      migration: {
        status: "rolled-back",
        at: "2026-05-23T10:00:00.000Z",
        reason: "keyring-unavailable",
        migratedProjectIds: [],
      },
    });

    render(<MigrationBanner />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/could not migrate your GitHub configuration/)).toBeTruthy(),
    );

    const link = screen.getByRole("link", { name: /open plugins page/i });
    expect(link.getAttribute("href")).toBe("/settings#plugins");
  });
});

describe("MigrationBanner — no-op", () => {
  it("renders nothing when there is no migration record", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: null,
      migration: null,
    });

    const { container } = render(<MigrationBanner />, { wrapper: makeWrapper() });

    // Wait for the query to settle, then assert the DOM is empty.
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe("");
  });
});
