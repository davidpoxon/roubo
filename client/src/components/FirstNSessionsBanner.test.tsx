// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FirstNSessionsBanner, { STORAGE_KEY } from "./FirstNSessionsBanner";

function setStoredEntry(routeKey: string, entry: { count: number; dismissed: boolean }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ [routeKey]: entry }));
}

function getStoredEntry(routeKey: string) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw)[routeKey] ?? null;
}

describe("FirstNSessionsBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders children on first session (no prior state)", () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={3}>
        Hello banner
      </FirstNSessionsBanner>,
    );
    expect(screen.getByText("Hello banner")).toBeTruthy();
  });

  it("renders nothing when session count has reached the limit", () => {
    setStoredEntry("test-key", { count: 3, dismissed: false });
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={3}>
        Hello banner
      </FirstNSessionsBanner>,
    );
    expect(screen.queryByText("Hello banner")).toBeNull();
  });

  it("renders nothing when dismissed flag is true", () => {
    setStoredEntry("test-key", { count: 1, dismissed: true });
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Hello banner
      </FirstNSessionsBanner>,
    );
    expect(screen.queryByText("Hello banner")).toBeNull();
  });

  it("renders nothing when sessionCount is 0", () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={0}>
        Should not appear
      </FirstNSessionsBanner>,
    );
    expect(screen.queryByText("Should not appear")).toBeNull();
  });

  it("renders nothing when sessionCount is negative", () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={-1}>
        Should not appear
      </FirstNSessionsBanner>,
    );
    expect(screen.queryByText("Should not appear")).toBeNull();
  });

  it("still renders on the last eligible session (count = sessionCount - 1)", () => {
    setStoredEntry("test-key", { count: 4, dismissed: false });
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Hello banner
      </FirstNSessionsBanner>,
    );
    expect(screen.getByText("Hello banner")).toBeTruthy();
  });

  it("increments count in localStorage after mount", async () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );
    await waitFor(() => {
      const entry = getStoredEntry("test-key");
      expect(entry).not.toBeNull();
      expect(entry.count).toBe(1);
      expect(entry.dismissed).toBe(false);
    });
  });

  it("does not increment count when already at the limit", async () => {
    setStoredEntry("test-key", { count: 5, dismissed: false });
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );
    await waitFor(() => {
      const entry = getStoredEntry("test-key");
      expect(entry?.count).toBe(5);
    });
  });

  it("shows dismiss button when banner is visible", () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );
    expect(screen.getByLabelText("Dismiss banner")).toBeTruthy();
  });

  it("hides banner immediately when dismiss button is clicked", async () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );
    await userEvent.click(screen.getByLabelText("Dismiss banner"));
    expect(screen.queryByText("Content")).toBeNull();
  });

  it("persists dismissed=true in localStorage after dismissal", async () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );
    await userEvent.click(screen.getByLabelText("Dismiss banner"));
    const entry = getStoredEntry("test-key");
    expect(entry?.dismissed).toBe(true);
  });

  it("renders nothing on remount after dismissal", async () => {
    // Simulate a dismissed state from a prior session
    setStoredEntry("test-key", { count: 2, dismissed: true });
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );
    expect(screen.queryByText("Content")).toBeNull();
  });

  it("handles corrupted localStorage JSON gracefully", () => {
    localStorage.setItem(STORAGE_KEY, "not-valid-json}}}");
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Fallback render
      </FirstNSessionsBanner>,
    );
    expect(screen.getByText("Fallback render")).toBeTruthy();
  });

  it("tracks independent state per routeKey", async () => {
    setStoredEntry("key-a", { count: 5, dismissed: false });
    // key-b has no entry: should still render

    render(
      <FirstNSessionsBanner routeKey="key-b" sessionCount={5}>
        Key B content
      </FirstNSessionsBanner>,
    );
    expect(screen.getByText("Key B content")).toBeTruthy();
  });

  it("renders with default aria-label and correct role", () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={3}>
        Hello banner
      </FirstNSessionsBanner>,
    );
    expect(screen.getByRole("note", { name: "Information" })).toBeTruthy();
  });

  it("renders with custom label prop as aria-label", () => {
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={3} label="My banner">
        Hello banner
      </FirstNSessionsBanner>,
    );
    expect(screen.getByRole("note", { name: "My banner" })).toBeTruthy();
  });

  it("hides banner on dismiss even when localStorage.setItem throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    render(
      <FirstNSessionsBanner routeKey="test-key" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );
    await userEvent.click(screen.getByLabelText("Dismiss banner"));
    expect(screen.queryByText("Content")).toBeNull();
  });

  it("does not affect other routeKey entries when writing", async () => {
    setStoredEntry("key-a", { count: 2, dismissed: false });

    render(
      <FirstNSessionsBanner routeKey="key-b" sessionCount={5}>
        Content
      </FirstNSessionsBanner>,
    );

    await waitFor(() => {
      const raw = localStorage.getItem(STORAGE_KEY);
      const store = JSON.parse(raw ?? "{}");
      expect(store["key-a"]).toEqual({ count: 2, dismissed: false });
      expect(store["key-b"]?.count).toBe(1);
    });
  });
});
