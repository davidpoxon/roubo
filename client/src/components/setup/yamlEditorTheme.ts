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
        backgroundColor: dark ? "rgb(12 10 9)" : "rgb(255 255 255)",
        color: dark ? "rgb(214 211 209)" : "rgb(28 25 23)",
      },
      ".cm-content": {
        fontFamily: FONT_FAMILY,
        padding: "12px 0",
        caretColor: "rgb(245 158 11)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "rgb(245 158 11)",
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "rgba(245,158,11,0.15)",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-line": {
        padding: "0 16px",
      },
      ".cm-gutters": {
        backgroundColor: dark ? "rgb(12 10 9)" : "rgb(250 250 249)",
        borderRight: dark ? "1px solid rgb(41 37 36)" : "1px solid rgb(231 229 228)",
        color: dark ? "rgb(68 64 60)" : "rgb(168 162 158)",
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
      ".cm-lintRange-error": {
        backgroundImage:
          "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2-2 l1 1 l2-2 l1 1' stroke='%23ef4444' fill='none'/></svg>\")",
      },
      ".cm-diagnostic-error": {
        borderLeft: "3px solid rgb(239 68 68)",
      },
    },
    { dark },
  );
}

const lightHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "rgb(2 132 199)" }, // sky-700 — keys
    { tag: tags.string, color: "rgb(180 83 9)" }, // amber-700 — string values
    { tag: [tags.number, tags.bool, tags.null], color: "rgb(4 120 87)" }, // emerald-700
    { tag: tags.comment, color: "rgb(120 113 108)", fontStyle: "italic" }, // stone-500
    { tag: [tags.punctuation, tags.meta], color: "rgb(120 113 108)" },
    { tag: tags.operator, color: "rgb(120 113 108)" },
  ]),
);

const darkHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "rgb(125 211 252)" }, // sky-300 — keys
    { tag: tags.string, color: "rgb(252 211 77)" }, // amber-300 — string values
    { tag: [tags.number, tags.bool, tags.null], color: "rgb(110 231 183)" }, // emerald-300
    { tag: tags.comment, color: "rgb(120 113 108)", fontStyle: "italic" }, // stone-500
    { tag: [tags.punctuation, tags.meta], color: "rgb(120 113 108)" },
    { tag: tags.operator, color: "rgb(120 113 108)" },
  ]),
);

export const yamlLightTheme: Extension[] = [buildBaseTheme(false), lightHighlight];
export const yamlDarkTheme: Extension[] = [buildBaseTheme(true), darkHighlight];
