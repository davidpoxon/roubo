import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const FONT_FAMILY =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace';

function buildBaseTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        fontFamily: FONT_FAMILY,
        fontSize: "12px",
        lineHeight: "1.65",
        backgroundColor: "var(--color-bg-field)",
        color: "var(--color-text-primary)",
      },
      ".cm-content": {
        fontFamily: FONT_FAMILY,
        padding: "12px 0",
        caretColor: "var(--color-accent)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--color-accent)",
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--color-accent-muted)",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-line": {
        padding: "0 16px",
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-bg-base)",
        borderRight: "1px solid var(--color-border)",
        color: "var(--color-text-secondary)",
        minWidth: "2.5rem",
        userSelect: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 8px 0 4px",
        textAlign: "right",
      },
      ".cm-scroller": {
        fontFamily: FONT_FAMILY,
      },
      // A wavy underline in the danger role, not CodeMirror's default SVG squiggle,
      // because a CSS variable cannot reach inside the data URI.
      ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "underline wavy var(--color-danger)",
        textDecorationSkipInk: "none",
        textUnderlineOffset: "3px",
      },
      ".cm-diagnostic-error": {
        borderLeft: "3px solid var(--color-danger)",
      },
    },
    { dark },
  );
}

// The chrome above and the neutral tokens below read DESIGN.md roles through
// var(--color-<role>), so they follow the theme switch in semantic-dark.css.
// Keys, strings, and literals keep per-theme hues because DESIGN.md records no
// code syntax role yet; the proposed syntax-* roles are tracked in #1331.
const NEUTRAL_SYNTAX = [
  { tag: tags.comment, color: "var(--color-text-secondary)", fontStyle: "italic" },
  { tag: [tags.punctuation, tags.meta], color: "var(--color-text-secondary)" },
  { tag: tags.operator, color: "var(--color-text-secondary)" },
];

const lightHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "rgb(7 89 133)" }, // keys
    { tag: tags.string, color: "rgb(180 83 9)" }, // string values
    { tag: [tags.number, tags.bool, tags.null], color: "rgb(6 95 70)" }, // literals
    ...NEUTRAL_SYNTAX,
  ]),
);

const darkHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "rgb(186 230 253)" }, // keys
    { tag: tags.string, color: "rgb(252 211 77)" }, // string values
    { tag: [tags.number, tags.bool, tags.null], color: "rgb(110 231 183)" }, // literals
    ...NEUTRAL_SYNTAX,
  ]),
);

export const yamlLightTheme: Extension[] = [buildBaseTheme(false), lightHighlight];
export const yamlDarkTheme: Extension[] = [buildBaseTheme(true), darkHighlight];
