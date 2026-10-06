import { describe, it, expect } from "vitest";
import { parseOsc52, OSC52_MAX_DECODED_BYTES } from "./osc52";

// Built independently of osc52.ts's own base64 handling, so a fixture cannot
// inherit the implementation's bug.
function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("parseOsc52", () => {
  it("decodes a c; (clipboard) write", () => {
    expect(parseOsc52(`c;${b64("hello")}`)).toEqual({ kind: "write", text: "hello" });
  });

  it("decodes an empty Pc as xterm's default selection", () => {
    expect(parseOsc52(`;${b64("hello")}`)).toEqual({ kind: "write", text: "hello" });
  });

  it("decodes a p; (primary) write", () => {
    expect(parseOsc52(`p;${b64("hello")}`)).toEqual({ kind: "write", text: "hello" });
  });

  it("decodes an s; (select) write", () => {
    expect(parseOsc52(`s;${b64("hello")}`)).toEqual({ kind: "write", text: "hello" });
  });

  it("round-trips non-ASCII text through UTF-8, not Latin-1", () => {
    // atob alone would yield "cafÃ© âœ“" here; this is the regression guard.
    expect(parseOsc52(`c;${b64("café ✓")}`)).toEqual({ kind: "write", text: "café ✓" });
  });

  it("recognises a read query and does not answer it", () => {
    expect(parseOsc52("c;?")).toEqual({ kind: "query" });
  });

  it("leaves a cut-buffer selector (0-7) unhandled", () => {
    expect(parseOsc52(`0;${b64("hello")}`)).toEqual({ kind: "unhandled" });
  });

  it("leaves the secondary selection (q) unhandled", () => {
    expect(parseOsc52(`q;${b64("hello")}`)).toEqual({ kind: "unhandled" });
  });

  it("is unhandled with no `;` separator", () => {
    expect(parseOsc52("c")).toEqual({ kind: "unhandled" });
  });

  it("does not throw and is unhandled for invalid base64", () => {
    expect(() => parseOsc52("c;not*valid*base64!")).not.toThrow();
    expect(parseOsc52("c;not*valid*base64!")).toEqual({ kind: "unhandled" });
  });

  it("is unhandled for an empty payload, so an agent cannot clear the clipboard", () => {
    expect(parseOsc52("c;")).toEqual({ kind: "unhandled" });
  });

  it("is unhandled for a payload over the size cap", () => {
    const huge = "A".repeat(Math.ceil(OSC52_MAX_DECODED_BYTES / 3) * 4 + 4);
    expect(parseOsc52(`c;${huge}`)).toEqual({ kind: "unhandled" });
  });
});
