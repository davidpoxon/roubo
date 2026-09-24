import { describe, it, expect } from "vitest";
import { ownSchemaErrorMessage } from "./ajv-schema-error-message.js";

describe("ownSchemaErrorMessage", () => {
  const schema = {
    type: "object",
    properties: {
      token: { type: "string", pattern: "^/", errorMessage: "takes a file path" },
      plain: { type: "string", pattern: "^/" },
      blank: { type: "string", pattern: "^/", errorMessage: "   " },
      auth: {
        type: "object",
        errorMessage: "auth block is misconfigured",
        properties: { key: { type: "string" } },
      },
      list: {
        type: "array",
        items: { type: "string", pattern: "^/", errorMessage: "each entry is a path" },
      },
    },
  };

  it("returns a property's own declared errorMessage for a pattern failure", () => {
    expect(ownSchemaErrorMessage({ keyword: "pattern", instancePath: "/token" }, schema)).toBe(
      "takes a file path",
    );
  });

  it("returns undefined when the property declares no errorMessage", () => {
    expect(
      ownSchemaErrorMessage({ keyword: "pattern", instancePath: "/plain" }, schema),
    ).toBeUndefined();
  });

  it("returns undefined for a blank (whitespace-only) errorMessage", () => {
    expect(
      ownSchemaErrorMessage({ keyword: "pattern", instancePath: "/blank" }, schema),
    ).toBeUndefined();
  });

  it("never reads a container's errorMessage for a required failure at that container", () => {
    // A required failure's instancePath is the container (/auth), not the
    // missing property; reading `errorMessage` there would silently swallow
    // the caller's own "missing property" detail.
    expect(
      ownSchemaErrorMessage({ keyword: "required", instancePath: "/auth" }, schema),
    ).toBeUndefined();
  });

  it("never reads a container's errorMessage for an additionalProperties failure at that container", () => {
    expect(
      ownSchemaErrorMessage({ keyword: "additionalProperties", instancePath: "/auth" }, schema),
    ).toBeUndefined();
  });

  it("resolves an errorMessage on an array's item schema", () => {
    expect(ownSchemaErrorMessage({ keyword: "pattern", instancePath: "/list/0" }, schema)).toBe(
      "each entry is a path",
    );
  });

  it("returns undefined when the instancePath does not resolve against the schema", () => {
    expect(
      ownSchemaErrorMessage({ keyword: "pattern", instancePath: "/missing" }, schema),
    ).toBeUndefined();
  });

  it("returns undefined when rootSchema is not an object (e.g. undefined configSchema)", () => {
    expect(
      ownSchemaErrorMessage({ keyword: "pattern", instancePath: "/token" }, undefined),
    ).toBeUndefined();
  });
});
