import { describe, it, expect } from "vitest";
import { parseIntParam, RouteError } from "./helpers.js";

describe("parseIntParam", () => {
  it("parses valid integers", () => {
    expect(parseIntParam("42", "id")).toBe(42);
    expect(parseIntParam("0", "id")).toBe(0);
    expect(parseIntParam("-1", "id")).toBe(-1);
  });

  it("throws RouteError with 400 for non-numeric strings", () => {
    expect(() => parseIntParam("abc", "bench id")).toThrow(RouteError);
    try {
      parseIntParam("abc", "bench id");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
      expect((err as RouteError).message).toBe("Invalid bench id");
    }
  });

  it("throws RouteError for empty string", () => {
    expect(() => parseIntParam("", "id")).toThrow(RouteError);
  });

  it("throws RouteError for undefined coerced to string", () => {
    expect(() => parseIntParam("undefined", "id")).toThrow(RouteError);
  });

  it("parses integer portion of float strings", () => {
    expect(parseIntParam("3.14", "id")).toBe(3);
  });
});
