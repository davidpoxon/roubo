// @vitest-environment node
/// <reference types="node" />
// The client tsconfig pins `types: ["vite/client"]`; this test reads the
// stylesheets through node:fs, so it references the node types explicitly.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "tailwindcss";

// The xterm theme in components/Terminal.tsx reads the DESIGN.md terminal roles
// from script (#1323). No utility class uses most of them, so Tailwind keeps
// them in the build only because globals.css imports the tokens with
// `theme(static)`. Without it they resolve to "" at runtime and xterm silently
// falls back to its own palette. Terminal.test.tsx cannot see that, because it
// supplies the variables itself, so this test compiles globals.css the way the
// build does and reads the emitted variables back.

const root = process.cwd();
const globalsPath = resolve(root, "client/src/globals.css");
const require = createRequire(import.meta.url);

function loadStylesheet(id: string, base: string) {
  const path = id === "tailwindcss" ? require.resolve("tailwindcss/index.css") : resolve(base, id);
  return Promise.resolve({ path, base: dirname(path), content: readFileSync(path, "utf8") });
}

// Build with no utility candidates, so only variables kept for their own sake
// (static theme variables, and those other CSS references) survive.
async function buildCss(css: string): Promise<string> {
  const compiler = await compile(css, { base: dirname(globalsPath), loadStylesheet });
  return compiler.build([]);
}

// Every terminal role DESIGN.md records, light key and `-dark` sibling alike.
function terminalColourKeys(): string[] {
  const designMd = readFileSync(resolve(root, "DESIGN.md"), "utf8");
  const block = /<!--\s*ui-design:tokens[^>]*-->\s*```json\s*\n([\s\S]*?)\n```/.exec(designMd);
  if (block?.[1] === undefined) throw new Error("DESIGN.md has no token block");
  const colors = (JSON.parse(block[1]) as { colors: Record<string, unknown> }).colors;
  return Object.keys(colors).filter((key) => key.startsWith("terminal-"));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

function declaredValue(css: string, key: string): string | undefined {
  return new RegExp(`--color-${escapeRegExp(key)}\\s*:\\s*(#[0-9a-fA-F]{6,8})\\s*;`).exec(css)?.[1];
}

describe("terminal colour roles in the built CSS (#1323)", () => {
  const keys = terminalColourKeys();

  it("covers every xterm theme role, light and dark", () => {
    // ground, text, cursor, selection, and sixteen ANSI colours, each twice.
    expect(keys).toHaveLength(40);
  });

  it("emits a value for every terminal role, though no utility uses most of them", async () => {
    const css = await buildCss(readFileSync(globalsPath, "utf8"));
    const missing = keys.filter((key) => declaredValue(css, key) === undefined);
    expect(missing).toEqual([]);
  });

  it("would lose the unused roles without theme(static), so the check above can fail", async () => {
    const withoutStatic = readFileSync(globalsPath, "utf8").replace(" theme(static)", "");
    const css = await buildCss(withoutStatic);
    expect(declaredValue(css, "terminal-ansi-red")).toBeUndefined();
  });
});
