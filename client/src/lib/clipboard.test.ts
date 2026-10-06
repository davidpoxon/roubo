// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { writeClipboard } from "./clipboard";

afterEach(() => {
  // Clean up window.roubo between tests, same as TitleBar.test.tsx.
  Object.defineProperty(window, "roubo", {
    value: undefined,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("writeClipboard", () => {
  it("prefers the Electron bridge and never touches navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    const bridge = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "roubo", {
      value: { writeClipboard: bridge },
      configurable: true,
    });

    const result = await writeClipboard("hello");
    expect(result).toBe(true);
    expect(bridge).toHaveBeenCalledWith("hello");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to navigator.clipboard.writeText when window.roubo is undefined", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const result = await writeClipboard("hello");
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("returns false and warns when navigator.clipboard.writeText rejects because the document is not focused", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException("Document is not focused.", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const result = await writeClipboard("hello");
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns false and warns when the bridge rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = vi.fn().mockRejectedValue(new Error("ipc failure"));
    Object.defineProperty(window, "roubo", {
      value: { writeClipboard: bridge },
      configurable: true,
    });

    const result = await writeClipboard("hello");
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns false when navigator.clipboard is undefined and there is no bridge", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const result = await writeClipboard("hello");
    expect(result).toBe(false);
  });

  it("returns false for empty text without calling the bridge or navigator.clipboard", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    const bridge = vi.fn();
    Object.defineProperty(window, "roubo", {
      value: { writeClipboard: bridge },
      configurable: true,
    });

    const result = await writeClipboard("");
    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });
});
