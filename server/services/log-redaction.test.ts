import { describe, it, expect } from "vitest";
import { redactSecrets } from "./log-redaction.js";

describe("redactSecrets", () => {
  it("redacts the Authorization value in a JSON-RPC host.fetch frame", () => {
    const frame =
      '{"jsonrpc":"2.0","id":191,"method":"host.fetch","params":{"url":"https://api.github.com/user","init":{"method":"GET","headers":{"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Authorization":"Bearer gho_0123456789abcdefghijABCDEFGHIJ"}}}}';
    const out = redactSecrets(frame);
    expect(out).not.toContain("gho_0123456789abcdefghijABCDEFGHIJ");
    expect(out).not.toContain("Bearer gho_");
    expect(out).toContain('"Authorization":"[REDACTED]"');
    // Non-secret fields are preserved.
    expect(out).toContain('"url":"https://api.github.com/user"');
    expect(out).toContain('"X-GitHub-Api-Version":"2022-11-28"');
  });

  it("redacts a non-Bearer Authorization value in JSON form", () => {
    const out = redactSecrets('{"Authorization":"token ghp_0123456789abcdefghijABCDEFGHIJ"}');
    expect(out).not.toContain("ghp_0123456789abcdefghijABCDEFGHIJ");
    expect(out).toContain('"Authorization":"[REDACTED]"');
  });

  it("redacts the lowercase authorization key", () => {
    const out = redactSecrets('{"authorization":"Bearer gho_0123456789abcdefghijABCDEFGHIJ"}');
    expect(out).not.toContain("gho_0123456789abcdefghijABCDEFGHIJ");
    expect(out).toContain('"authorization":"[REDACTED]"');
  });

  it("redacts an Authorization HTTP header line", () => {
    const out = redactSecrets("Authorization: Bearer gho_0123456789abcdefghijABCDEFGHIJ");
    expect(out).not.toContain("gho_0123456789abcdefghijABCDEFGHIJ");
    expect(out).toBe("Authorization: [REDACTED]");
  });

  it("redacts a bare Bearer token", () => {
    const out = redactSecrets("retrying with Bearer gho_0123456789abcdefghijABCDEFGHIJ now");
    expect(out).toBe("retrying with Bearer [REDACTED] now");
  });

  it("redacts bare GitHub token shapes", () => {
    expect(redactSecrets("token=ghp_0123456789abcdefghijABCDEFGHIJ done")).toBe(
      "token=[REDACTED] done",
    );
    expect(redactSecrets("github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ used")).toBe(
      "[REDACTED] used",
    );
  });

  it("redacts generic credential JSON keys", () => {
    expect(redactSecrets('{"token":"abc123","secret":"shh","password":"hunter2"}')).toBe(
      '{"token":"[REDACTED]","secret":"[REDACTED]","password":"[REDACTED]"}',
    );
    expect(redactSecrets('{"access_token":"xyz","refresh_token":"qrs"}')).toBe(
      '{"access_token":"[REDACTED]","refresh_token":"[REDACTED]"}',
    );
  });

  it("leaves non-secret text untouched", () => {
    const text = 'plugin started: fetched 12 issues from "owner/repo" in 240ms';
    expect(redactSecrets(text)).toBe(text);
  });

  it("is idempotent on already-redacted text", () => {
    const once = redactSecrets('{"Authorization":"Bearer gho_0123456789abcdefghijABCDEFGHIJ"}');
    expect(redactSecrets(once)).toBe(once);
  });

  it("handles empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});
