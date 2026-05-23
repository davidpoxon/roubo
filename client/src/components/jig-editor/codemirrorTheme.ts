import {
  EditorView,
  Decoration,
  ViewPlugin,
  type ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";

const FONT_FAMILY =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace';

function buildBaseTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        fontFamily: FONT_FAMILY,
        fontSize: "13px",
        lineHeight: "1.7",
        backgroundColor: dark ? "rgb(28 25 23)" : "rgb(250 250 249)",
        color: dark ? "rgb(231 229 228)" : "rgb(28 25 23)",
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
        backgroundColor: "rgba(245,158,11,0.18)",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-line": {
        padding: "0 16px",
      },
      ".cm-gutters": {
        display: "none",
      },
      ".cm-scroller": {
        fontFamily: FONT_FAMILY,
      },
      ".cm-roubo-var": {
        color: dark ? "rgb(103 232 249)" : "rgb(8 145 178)",
        backgroundColor: dark ? "rgba(6,182,212,0.08)" : "rgba(8,145,178,0.08)",
        borderRadius: "3px",
      },
    },
    { dark },
  );
}

const lightHighlight = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.heading1, tags.heading2, tags.heading3],
      fontWeight: "600",
      color: "rgb(28 25 23)",
    },
    {
      tag: [tags.heading4, tags.heading5, tags.heading6],
      fontWeight: "600",
      color: "rgb(87 83 78)",
    },
    { tag: tags.strong, fontWeight: "600" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: "rgb(180 83 9)", textDecoration: "underline" },
    {
      tag: tags.monospace,
      color: "rgb(8 145 178)",
      backgroundColor: "rgba(8,145,178,0.08)",
      borderRadius: "3px",
    },
    { tag: tags.quote, color: "rgb(120 113 108)" },
    { tag: tags.meta, color: "rgb(120 113 108)" },
    { tag: tags.comment, color: "rgb(168 162 158)", fontStyle: "italic" },
  ]),
);

const darkHighlight = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.heading1, tags.heading2, tags.heading3],
      fontWeight: "600",
      color: "rgb(231 229 228)",
    },
    {
      tag: [tags.heading4, tags.heading5, tags.heading6],
      fontWeight: "600",
      color: "rgb(168 162 158)",
    },
    { tag: tags.strong, fontWeight: "600" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: "rgb(252 211 77)", textDecoration: "underline" },
    {
      tag: tags.monospace,
      color: "rgb(103 232 249)",
      backgroundColor: "rgba(6,182,212,0.08)",
      borderRadius: "3px",
    },
    { tag: tags.quote, color: "rgb(120 113 108)" },
    { tag: tags.meta, color: "rgb(120 113 108)" },
    { tag: tags.comment, color: "rgb(87 83 78)", fontStyle: "italic" },
  ]),
);

export const lightTheme: Extension[] = [buildBaseTheme(false), lightHighlight];
export const darkTheme: Extension[] = [buildBaseTheme(true), darkHighlight];

const VAR_PATTERN = /\{\{[^}]+\}\}/g;
const varMark = Decoration.mark({ class: "cm-roubo-var" });

export const variableHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let match: RegExpExecArray | null;
        VAR_PATTERN.lastIndex = 0;
        while ((match = VAR_PATTERN.exec(text)) !== null) {
          const start = from + match.index;
          const end = start + match[0].length;
          builder.add(start, end, varMark);
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);
