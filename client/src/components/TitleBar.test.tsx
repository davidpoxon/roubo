// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TitleBar from "./TitleBar";

afterEach(() => {
  // Clean up window.roubo between tests
  Object.defineProperty(window, "roubo", {
    value: undefined,
    configurable: true,
  });
});

describe("TitleBar", () => {
  it("renders the ROUBO title when no projectName is given", () => {
    render(<TitleBar />);
    expect(screen.getByText("ROUBO")).toBeDefined();
  });

  it("renders project name instead of ROUBO when projectName is provided", () => {
    render(<TitleBar projectName="responda" />);
    expect(screen.getByText("responda")).toBeDefined();
    expect(screen.queryByText("ROUBO")).toBeNull();
  });

  it("applies mac padding when platform is darwin", () => {
    Object.defineProperty(window, "roubo", {
      value: {
        platform: "darwin",
        onDeepLink: () => () => {},
        setTitleBarOverlayTheme: () => {},
      },
      configurable: true,
    });
    const { container } = render(<TitleBar />);
    expect(container.querySelector(".pl-\\[92px\\]")).not.toBeNull();
  });

  it("applies non-mac padding when platform is not darwin", () => {
    Object.defineProperty(window, "roubo", {
      value: {
        platform: "win32",
        onDeepLink: () => () => {},
        setTitleBarOverlayTheme: () => {},
      },
      configurable: true,
    });
    const { container } = render(<TitleBar />);
    expect(container.querySelector(".pl-5")).not.toBeNull();
  });

  it("applies non-mac padding when roubo is not defined", () => {
    const { container } = render(<TitleBar />);
    expect(container.querySelector(".pl-5")).not.toBeNull();
  });
});
