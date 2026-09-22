import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DASH_LINE_PAIRS_MAX_LINES,
  PROBE_PARSE_REGISTRY,
  readProbeOutput,
} from "./probe-parse-registry.js";

// Captured from `--list-models` during the model-probe spike and copied from
// .specifications/agent-plugins-cursor-cli/spikes/spike-848/ in the meta-repo.
const FIXTURE = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "__fixtures__/probe-output/list-models.fixture.txt",
  ),
  "utf8",
);

const ok = (stdout: string, stderr = "") => ({ code: 0, stdout, stderr });

describe("PROBE_PARSE_REGISTRY", () => {
  // The registry's type is a record over the schema literals, so a missing reader
  // is already a typecheck failure. This pins the two that exist today.
  it("has a reader for every parse literal the manifest schemas accept", () => {
    for (const mode of ["semver", "dash-line-pairs"] as const) {
      expect(typeof PROBE_PARSE_REGISTRY[mode]).toBe("function");
    }
  });
});

describe("semver reader", () => {
  it("reads the first version out of stdout and stderr merged", () => {
    expect(readProbeOutput("semver", ok("", "tool 1.2.3"))).toEqual({ ok: true, value: "1.2.3" });
  });

  it("lets a version found in the output win over a nonzero exit", () => {
    expect(readProbeOutput("semver", { code: 3, stdout: "1.2.3", stderr: "" })).toEqual({
      ok: true,
      value: "1.2.3",
    });
  });

  it("reports a nonzero exit with no version as a probe error, with the first line", () => {
    expect(readProbeOutput("semver", { code: 127, stdout: "", stderr: "not found\nmore" })).toEqual(
      { ok: false, cause: "probe-error", detail: "exited with code 127: not found" },
    );
  });

  it("reports a clean exit with no version as a parse error", () => {
    expect(readProbeOutput("semver", ok("no number here"))).toMatchObject({
      ok: false,
      cause: "parse-error",
    });
  });
});

describe("dash-line-pairs reader (model-probe spike)", () => {
  it("reads 223 pairs from the captured listing", () => {
    const reading = readProbeOutput("dash-line-pairs", ok(FIXTURE));
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value).toHaveLength(223);
    expect(reading.value[0]).toEqual({ value: "auto", label: "Auto (current, default)" });
  });

  it("keeps matching lines, skips every other line, and handles CRLF", () => {
    const reading = readProbeOutput(
      "dash-line-pairs",
      ok("Available models\r\n\r\na - Alpha\r\n  indented - no\r\nb - Beta - two\r\nTip: x\r\n"),
    );
    expect(reading).toEqual({
      ok: true,
      value: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta - two" },
      ],
    });
  });

  it("reads stdout only", () => {
    expect(readProbeOutput("dash-line-pairs", ok("", "a - Alpha"))).toMatchObject({
      ok: false,
      cause: "parse-error",
    });
  });

  it("treats a nonzero exit as a probe error with the first stderr line, even with pairs on stdout", () => {
    expect(
      readProbeOutput("dash-line-pairs", {
        code: 1,
        stdout: "a - Alpha",
        stderr: "\nnot signed in\nrun login",
      }),
    ).toEqual({ ok: false, cause: "probe-error", detail: "exited with code 1: not signed in" });
  });

  it("treats zero pairs as a parse error", () => {
    expect(readProbeOutput("dash-line-pairs", ok("Available models\n\nnothing\n"))).toMatchObject({
      ok: false,
      cause: "parse-error",
    });
  });

  it(`reads a listing of exactly ${DASH_LINE_PAIRS_MAX_LINES} lines that ends in a newline`, () => {
    const full =
      Array.from({ length: DASH_LINE_PAIRS_MAX_LINES }, (_, i) => `m${i} - M`).join("\n") + "\n";
    const reading = readProbeOutput("dash-line-pairs", ok(full));
    expect(reading.ok).toBe(true);
    expect(reading.ok && reading.value).toHaveLength(DASH_LINE_PAIRS_MAX_LINES);
  });

  it(`refuses a listing longer than ${DASH_LINE_PAIRS_MAX_LINES} lines`, () => {
    const long = Array.from({ length: DASH_LINE_PAIRS_MAX_LINES + 1 }, (_, i) => `m${i} - M`).join(
      "\n",
    );
    expect(readProbeOutput("dash-line-pairs", ok(long))).toMatchObject({
      ok: false,
      cause: "parse-error",
    });
  });

  it("refuses output that was cut at the size bound", () => {
    expect(
      readProbeOutput("dash-line-pairs", { ...ok("a - Alpha"), truncated: true }),
    ).toMatchObject({ ok: false, cause: "parse-error" });
  });

  // APCC-TC-020: the reader returns what the CLI printed as plain strings. Markup
  // and control characters survive verbatim; nothing here interprets them.
  it("returns markup and control characters verbatim as text", () => {
    const reading = readProbeOutput(
      "dash-line-pairs",
      ok("<b>bold</b> - <script>alert(1)</script>\n\u001b[31mred\u001b[0m - \u0007bell"),
    );
    expect(reading).toEqual({
      ok: true,
      value: [
        { value: "<b>bold</b>", label: "<script>alert(1)</script>" },
        { value: "\u001b[31mred\u001b[0m", label: "\u0007bell" },
      ],
    });
  });
});
