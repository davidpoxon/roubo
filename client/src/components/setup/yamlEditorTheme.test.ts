// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { yamlLightTheme, yamlDarkTheme } from "./yamlEditorTheme";

// @lezer/yaml tags every plain scalar as `content`, never as number, bool, or
// null, so a HighlightStyle rule on those tags matches nothing. The theme marks
// literals itself; these tests pin which scalars it marks.
const DOC = [
  "name: roubo",
  'quoted: "4"',
  "count: 4",
  "negative: -12",
  "ratio: 1.5",
  "exp: 1e3",
  "hex: 0x1F",
  "octal: 0o17",
  "inf: .inf",
  "enabled: true",
  "disabled: False",
  "owner: null",
  "tilde: ~",
  "setup: npm i",
  "version: 1.2.3",
  "flow: [8, yes, NULL]",
  "true: key",
  "",
].join("\n");

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(theme: typeof yamlLightTheme): HTMLElement {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({ doc: DOC, extensions: [yaml(), theme] }),
  });
  return parent;
}

function markedLiterals(theme: typeof yamlLightTheme): string[] {
  const parent = mount(theme);
  return [...parent.querySelectorAll(".cm-yaml-literal")].map((el) => el.textContent ?? "");
}

// The colour the injected CodeMirror style rules give the span holding `text`
// on the given line. jsdom does not cascade custom properties, so this reads
// the declared value, for example `var(--color-syntax-key)`.
function declaredColor(parent: HTMLElement, line: number, text: string): string | undefined {
  const lineEl = parent.querySelectorAll(".cm-line")[line];
  const span = [...lineEl.querySelectorAll("span")].find((el) => el.textContent === text);
  if (!span) return undefined;
  let color: string | undefined;
  for (const sheet of [...document.styleSheets]) {
    for (const rule of [...sheet.cssRules]) {
      if (rule instanceof CSSStyleRule && rule.style.color && span.matches(rule.selectorText)) {
        color = rule.style.color;
      }
    }
  }
  return color;
}

describe("yamlEditorTheme literal highlighting", () => {
  it.each([
    ["light", yamlLightTheme],
    ["dark", yamlDarkTheme],
  ])("marks YAML 1.2 core-schema numbers, booleans, and nulls in the %s theme", (_name, theme) => {
    expect(markedLiterals(theme)).toEqual([
      "4",
      "-12",
      "1.5",
      "1e3",
      "0x1F",
      "0o17",
      ".inf",
      "true",
      "False",
      "null",
      "~",
      "8",
      "NULL",
    ]);
  });

  it.each([
    ["light", yamlLightTheme],
    ["dark", yamlDarkTheme],
  ])("paints keys, strings, and literals with the syntax roles in the %s theme", (_name, theme) => {
    const parent = mount(theme);
    expect(declaredColor(parent, 2, "count")).toBe("var(--color-syntax-key)");
    expect(declaredColor(parent, 1, '"4"')).toBe("var(--color-syntax-string)");
    expect(declaredColor(parent, 2, "4")).toBe("var(--color-syntax-literal)");
    expect(declaredColor(parent, 13, "npm i")).toBeUndefined();
  });
});
