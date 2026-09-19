import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALLOWLIST_PATH,
  applyAllowlist,
  colourTokenNames,
  EXTRA_FILES,
  listFiles,
  scanSource,
  scanTree,
} from "./design-token-guard.mjs";

const TOKENS = new Set(["bg-surface", "text-secondary", "border"]);

function utilities(source: string) {
  return scanSource(source, TOKENS).map((f) => `${f.rule}:${f.utility}`);
}

describe("scanSource (DesignTokenGuard)", () => {
  it("passes semantic role utilities, including ones whose name repeats the prefix", () => {
    expect(
      utilities(
        '<p className="bg-bg-surface text-text-secondary border-border hover:bg-bg-hover">',
      ),
    ).toEqual([]);
  });

  it("flags a raw palette shade under the common utility prefixes", () => {
    // The regression this guard exists for: `text-stone-500` is light-only and
    // measured 3.65:1 in dark, yet passed every gate.
    expect(
      utilities('className="text-stone-500 bg-amber-500 border-red-200 ring-green-600"'),
    ).toEqual([
      "raw-palette:text-stone-500",
      "raw-palette:bg-amber-500",
      "raw-palette:border-red-200",
      "raw-palette:ring-green-600",
    ]);
  });

  it("flags the categorical families and the less common colour prefixes", () => {
    expect(
      utilities(
        "fill-violet-600 stroke-cyan-400 from-emerald-500 via-sky-500 to-rose-500 " +
          "divide-stone-800 placeholder-stone-400 shadow-stone-900 accent-amber-500 " +
          "caret-amber-500 decoration-amber-400 outline-indigo-500 ring-offset-stone-950 " +
          "border-t-stone-400",
      ),
    ).toHaveLength(14);
  });

  it("flags a shade behind a variant chain, with an opacity modifier, or marked important", () => {
    expect(
      utilities(
        "hover:bg-stone-100 data-[selected]:text-amber-700 group-hover/item:bg-red-500/15 " +
          "!text-green-800 [&>svg]:text-stone-400",
      ),
    ).toEqual([
      "raw-palette:hover:bg-stone-100",
      "raw-palette:data-[selected]:text-amber-700",
      "raw-palette:group-hover/item:bg-red-500/15",
      "raw-palette:!text-green-800",
      "raw-palette:[&>svg]:text-stone-400",
    ]);
  });

  it("reports a dark: palette pair once, as a dark: colour variant", () => {
    expect(utilities("text-stone-700 dark:text-stone-300 dark:hover:bg-stone-800")).toEqual([
      "raw-palette:text-stone-700",
      "dark-variant:dark:text-stone-300",
      "dark-variant:dark:hover:bg-stone-800",
    ]);
  });

  it("flags a dark: variant on any colour, including keywords, arbitrary values, and tokens", () => {
    expect(
      utilities(
        "dark:shadow-black/20 dark:bg-white dark:text-[#fafaf9] dark:bg-bg-surface dark:border-border",
      ),
    ).toEqual([
      "dark-variant:dark:shadow-black/20",
      "dark-variant:dark:bg-white",
      "dark-variant:dark:text-[#fafaf9]",
      "dark-variant:dark:bg-bg-surface",
      "dark-variant:dark:border-border",
    ]);
  });

  it("ignores dark: variants that do not paint a colour", () => {
    expect(utilities("dark:text-sm dark:border-2 dark:shadow-none dark:opacity-80")).toEqual([]);
  });

  it("ignores names that only contain a palette word", () => {
    expect(utilities("const reduced = 'go-to-red-500'; const tone = stone-500;")).toEqual([]);
  });

  it("reports the line of each finding", () => {
    const findings = scanSource("const a = 1;\nconst b = 'text-stone-500';\n", TOKENS);
    expect(findings).toEqual([{ line: 2, utility: "text-stone-500", rule: "raw-palette" }]);
  });
});

describe("colourTokenNames (DesignTokenGuard)", () => {
  it("collects every --color-* declaration name", () => {
    const names = colourTokenNames([
      "@theme { --color-bg-surface: #fff; --color-bg-surface-dark: #1c1917; }",
      ".dark { --color-bg-surface: var(--color-bg-surface-dark); }",
    ]);
    expect([...names].sort()).toEqual(["bg-surface", "bg-surface-dark"]);
  });
});

describe("applyAllowlist (DesignTokenGuard)", () => {
  const finding = { line: 1, utility: "text-stone-500", rule: "raw-palette" };

  it("reports a violation in a file no entry covers", () => {
    const { violations, problems } = applyAllowlist({ "client/src/App.tsx": [finding] }, []);
    expect(violations).toEqual([{ file: "client/src/App.tsx", ...finding }]);
    expect(problems).toEqual([]);
  });

  it("skips files under a directory entry and a matching file entry", () => {
    const { violations, problems } = applyAllowlist(
      {
        "client/src/components/setup/Wizard.tsx": [finding],
        "client/src/components/setup/steps/Step.tsx": [finding],
        "client/src/components/Card.tsx": [finding],
      },
      ["client/src/components/setup/", "client/src/components/Card.tsx"],
    );
    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("does not let a file entry cover a sibling file", () => {
    const { violations } = applyAllowlist({ "client/src/components/CardList.tsx": [finding] }, [
      "client/src/components/Card.tsx",
    ]);
    expect(violations).toHaveLength(1);
  });

  it("fails an entry that no longer covers any violation, so the list only shrinks", () => {
    const { problems } = applyAllowlist(
      {
        "client/src/components/setup/Wizard.tsx": [],
        "client/src/components/Card.tsx": [finding],
      },
      ["client/src/components/setup/", "client/src/components/Card.tsx", "client/src/Gone.tsx"],
    );
    expect(problems.map((p) => p.entry)).toEqual([
      "client/src/components/setup/",
      "client/src/Gone.tsx",
    ]);
    expect(problems[0].reason).toMatch(/stale/);
  });

  it("fails duplicate, overlapping, and out-of-tree entries", () => {
    const { problems } = applyAllowlist({ "client/src/components/setup/Wizard.tsx": [finding] }, [
      "client/src/components/setup/",
      "client/src/components/setup/",
      "client/src/components/setup/Wizard.tsx",
      "server/index.ts",
    ]);
    expect(problems.map((p) => p.reason)).toEqual([
      expect.stringMatching(/more than once/),
      expect.stringMatching(/already covered/),
      expect.stringMatching(/outside client\/src/),
    ]);
  });
});

describe("listFiles (DesignTokenGuard)", () => {
  it("covers client/index.html, whose body classes paint before React mounts", () => {
    expect(EXTRA_FILES).toEqual(["client/index.html"]);
    expect(listFiles()).toContain("client/index.html");
  });

  it("flags raw shades in an HTML class attribute", () => {
    expect(utilities('<body class="bg-white text-stone-900 dark:bg-stone-950">')).toEqual([
      "raw-palette:text-stone-900",
      "dark-variant:dark:bg-stone-950",
    ]);
  });
});

describe("the committed client and allowlist", () => {
  it("pass the guard", () => {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).entries;
    const { violations, problems } = applyAllowlist(scanTree(), allowlist);
    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });
});
