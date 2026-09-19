import {
  EditorView,
  Decoration,
  ViewPlugin,
  type ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxHighlighting, syntaxTree, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { RangeSetBuilder } from "@codemirror/state";
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

// Every colour in the chrome above and the highlight below is a DESIGN.md role
// read through var(--color-<role>), so it follows the theme switch in
// semantic-dark.css. One highlight style therefore serves both themes; the
// `dark` flag only tells CodeMirror which of its own base styles to apply.
const yamlHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--color-syntax-key)" },
    { tag: tags.string, color: "var(--color-syntax-string)" },
    { tag: tags.comment, color: "var(--color-text-secondary)", fontStyle: "italic" },
    { tag: [tags.punctuation, tags.meta], color: "var(--color-text-secondary)" },
    { tag: tags.operator, color: "var(--color-text-secondary)" },
  ]),
);

// @lezer/yaml tags every plain scalar as `content`, never as number, bool, or
// null, so a HighlightStyle rule cannot tell `4` from `npm i`. This plugin marks
// the plain scalars the YAML 1.2 core schema resolves to a number, boolean, or
// null, and the theme paints the mark in `syntax-literal`.
const CORE_SCHEMA_LITERAL = new RegExp(
  "^(?:" +
    ["null|Null|NULL|~", "true|True|TRUE|false|False|FALSE"].join("|") +
    "|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+" +
    "|[-+]?(?:\\.[0-9]+|[0-9]+(?:\\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?" +
    "|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN)" +
    ")$",
);

const literalMark = Decoration.mark({ class: "cm-yaml-literal" });

function literalDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Literal" || node.node.parent?.name === "Key") return;
        if (CORE_SCHEMA_LITERAL.test(view.state.doc.sliceString(node.from, node.to))) {
          builder.add(node.from, node.to, literalMark);
        }
      },
    });
  }
  return builder.finish();
}

const yamlLiterals = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = literalDecorations(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = literalDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
  EditorView.baseTheme({ ".cm-yaml-literal": { color: "var(--color-syntax-literal)" } }),
];

export const yamlLightTheme: Extension[] = [buildBaseTheme(false), yamlHighlight, yamlLiterals];
export const yamlDarkTheme: Extension[] = [buildBaseTheme(true), yamlHighlight, yamlLiterals];
