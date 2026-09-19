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

// Every colour is a DESIGN.md semantic role read through its CSS variable.
// design-tokens/semantic-dark.css switches each variable under `.dark`, so the
// editor follows the theme without a per-theme colour branch. The `dark` flag
// only tells CodeMirror which of its own base styles to apply. The ground is
// left transparent so the host element paints it by role: `bg-bg-field` for the
// editor (an input) and `bg-bg-surface` for the read-only preview.
const color = (role: string) => `var(--color-${role})`;

function buildBaseTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        fontFamily: FONT_FAMILY,
        fontSize: "13px",
        lineHeight: "1.7",
        backgroundColor: "transparent",
        color: color("text-primary"),
      },
      ".cm-content": {
        fontFamily: FONT_FAMILY,
        padding: "12px 0",
        caretColor: color("accent"),
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: color("accent"),
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: color("accent-muted"),
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
      // A template variable is the one token the editor calls out: accent text
      // on its own muted ground, the pairing DESIGN.md gives accent text.
      ".cm-roubo-var": {
        color: color("accent-text"),
        backgroundColor: color("accent-muted"),
        borderRadius: "3px",
      },
    },
    { dark },
  );
}

const markdownHighlight = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.heading1, tags.heading2, tags.heading3],
      fontWeight: "600",
      color: color("text-primary"),
    },
    {
      tag: [tags.heading4, tags.heading5, tags.heading6],
      fontWeight: "600",
      color: color("text-secondary"),
    },
    { tag: tags.strong, fontWeight: "600" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: color("accent-text"), textDecoration: "underline" },
    {
      tag: tags.monospace,
      color: color("text-body"),
      backgroundColor: color("bg-hover"),
      borderRadius: "3px",
    },
    { tag: tags.quote, color: color("text-secondary") },
    { tag: tags.meta, color: color("text-secondary") },
    { tag: tags.comment, color: color("text-secondary"), fontStyle: "italic" },
  ]),
);

export const lightTheme: Extension[] = [buildBaseTheme(false), markdownHighlight];
export const darkTheme: Extension[] = [buildBaseTheme(true), markdownHighlight];

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
