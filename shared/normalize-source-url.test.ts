import { describe, it, expect } from "vitest";
import { normalizeSourceUrl } from "./normalize-source-url.js";

// CPHMTP-FR-007 / CPHMTP-TC-080, issue #565: the one normalisation shared by the
// server's registration and the client's declared-source comparison. Casing and
// trailing-slash spellings of the same endpoint must collapse to one href so a
// declared URL matching a registered source shows no duplicate offer.

describe("normalizeSourceUrl: casing and trailing-slash equivalence (CPHMTP-TC-080)", () => {
  it("returns the WHATWG-normalised href for a plain https URL", () => {
    expect(normalizeSourceUrl("https://marketplace.acme.example/catalog.json")).toBe(
      "https://marketplace.acme.example/catalog.json",
    );
  });

  it("lower-cases an uppercased scheme and host", () => {
    expect(normalizeSourceUrl("HTTPS://MARKETPLACE.ACME.EXAMPLE/catalog.json")).toBe(
      "https://marketplace.acme.example/catalog.json",
    );
  });

  it("canonicalises a bare-origin trailing slash to the same href", () => {
    expect(normalizeSourceUrl("https://marketplace.acme.example")).toBe(
      normalizeSourceUrl("https://marketplace.acme.example/"),
    );
  });

  it("drops the default https port", () => {
    expect(normalizeSourceUrl("https://marketplace.acme.example:443/catalog.json")).toBe(
      "https://marketplace.acme.example/catalog.json",
    );
  });

  it("treats a casing-and-trailing-slash variant as the same source", () => {
    const canonical = normalizeSourceUrl("https://marketplace.acme.example/catalog/");
    const variant = normalizeSourceUrl("HTTPS://Marketplace.Acme.Example:443/catalog/");
    expect(variant).toBe(canonical);
  });

  it("preserves a path's case and the query string (only scheme/host are case-insensitive)", () => {
    expect(normalizeSourceUrl("https://acme.example/Catalog.JSON?ref=Main")).toBe(
      "https://acme.example/Catalog.JSON?ref=Main",
    );
  });

  it("accepts a plain-http URL (the http/https gate lives at the registration layer)", () => {
    expect(normalizeSourceUrl("http://marketplace.intranet/catalog.json")).toBe(
      "http://marketplace.intranet/catalog.json",
    );
  });

  it("rejects a non-http(s) scheme", () => {
    expect(normalizeSourceUrl("ftp://marketplace.acme.example/catalog.json")).toBeNull();
    expect(normalizeSourceUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeSourceUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects a value that is not a URL", () => {
    expect(normalizeSourceUrl("not a url")).toBeNull();
    expect(normalizeSourceUrl("")).toBeNull();
  });
});
