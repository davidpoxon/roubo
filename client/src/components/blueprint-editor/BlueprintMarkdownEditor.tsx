import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { lightTheme, darkTheme, variableHighlightPlugin } from "./codemirrorTheme";

export interface BlueprintMarkdownEditorRef {
  insertAtCursor(text: string): void;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

const BlueprintMarkdownEditor = forwardRef<BlueprintMarkdownEditorRef, Props>(
  function BlueprintMarkdownEditor({ value, onChange, ariaLabel }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const ariaLabelRef = useRef(ariaLabel ?? "Blueprint content editor");
    const initialValueRef = useRef(value);
    const themeCompartment = useRef(new Compartment());
    const suppressEcho = useRef(false);

    onChangeRef.current = onChange;
    ariaLabelRef.current = ariaLabel ?? "Blueprint content editor";

    useEffect(() => {
      if (!hostRef.current) return;

      const initialTheme = isDark() ? darkTheme : lightTheme;

      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: initialValueRef.current,
          extensions: [
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            markdown(),
            EditorView.lineWrapping,
            themeCompartment.current.of(initialTheme),
            variableHighlightPlugin,
            EditorView.updateListener.of((update) => {
              if (update.docChanged && !suppressEcho.current) {
                onChangeRef.current(update.state.doc.toString());
              }
            }),
            EditorView.contentAttributes.of({
              "aria-label": ariaLabelRef.current,
              "aria-multiline": "true",
            }),
          ],
        }),
      });

      viewRef.current = view;

      const observer = new MutationObserver(() => {
        const nextTheme = isDark() ? darkTheme : lightTheme;
        view.dispatch({ effects: themeCompartment.current.reconfigure(nextTheme) });
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

      return () => {
        observer.disconnect();
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    // Reconcile controlled value changes from outside
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      suppressEcho.current = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
      suppressEcho.current = false;
    }, [value]);

    useImperativeHandle(
      ref,
      () => ({
        insertAtCursor(text: string) {
          const view = viewRef.current;
          if (!view) return;
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
          });
          view.focus();
        },
        focus() {
          viewRef.current?.focus();
        },
      }),
      [],
    );

    return (
      <div
        ref={hostRef}
        className="h-full w-full overflow-auto rounded-lg border border-stone-200 dark:border-stone-800/60 focus-within:ring-1 focus-within:ring-stone-400 dark:focus-within:ring-stone-600"
        data-testid="blueprint-markdown-editor"
      />
    );
  },
);

export default BlueprintMarkdownEditor;
