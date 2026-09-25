import { describe, it, expect } from "vitest";
import { resolveLaunchTheme, themeEnvHint } from "./launch-theme.js";

describe("resolveLaunchTheme (#1383)", () => {
  it("prefers the client's resolved theme over the stored preference", () => {
    expect(resolveLaunchTheme("light", "dark")).toBe("light");
    expect(resolveLaunchTheme("dark", "system")).toBe("dark");
  });

  it("falls back to an explicit stored theme", () => {
    expect(resolveLaunchTheme(undefined, "light")).toBe("light");
    expect(resolveLaunchTheme(undefined, "dark")).toBe("dark");
  });

  it("gives no theme for a stored system preference with no client theme", () => {
    expect(resolveLaunchTheme(undefined, "system")).toBeUndefined();
    expect(resolveLaunchTheme(undefined, undefined)).toBeUndefined();
  });

  it("drops a requested value that is not a theme name", () => {
    expect(resolveLaunchTheme("system", undefined)).toBeUndefined();
    expect(resolveLaunchTheme("15;0", "light")).toBe("light");
    expect(resolveLaunchTheme({ theme: "dark" }, undefined)).toBeUndefined();
  });
});

describe("themeEnvHint (#1383)", () => {
  it("maps light to a white background and dark to a black one", () => {
    expect(themeEnvHint("light")).toEqual({ COLORFGBG: "0;15" });
    expect(themeEnvHint("dark")).toEqual({ COLORFGBG: "15;0" });
  });

  it("adds nothing when the theme is unknown", () => {
    expect(themeEnvHint(undefined)).toEqual({});
  });
});
