import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import * as YAML from "yaml";
import { yamlLightTheme, yamlDarkTheme } from "./yamlEditorTheme";

export interface SetupYamlEditorRef {
  focus(): void;
  format(): void;
  scrollToLine(line: number): void;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  diagnostics?: Diagnostic[];
  onSave?: () => void;
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

const SetupYamlEditor = forwardRef<SetupYamlEditorRef, Props>(function SetupYamlEditor(
  { value, onChange, diagnostics, onSave },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const initialValueRef = useRef(value);
  const themeCompartment = useRef(new Compartment());
  const suppressEcho = useRef(false);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!hostRef.current) return;

    const initialTheme = isDark() ? yamlDarkTheme : yamlLightTheme;

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
          ]),
          lineNumbers(),
          yaml(),
          lintGutter(),
          EditorView.lineWrapping,
          themeCompartment.current.of(initialTheme),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !suppressEcho.current) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          EditorView.contentAttributes.of({
            "aria-label": "roubo.yaml editor",
            "aria-multiline": "true",
          }),
        ],
      }),
    });

    viewRef.current = view;

    const observer = new MutationObserver(() => {
      const nextTheme = isDark() ? yamlDarkTheme : yamlLightTheme;
      view.dispatch({
        effects: themeCompartment.current.reconfigure(nextTheme),
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

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

  // Push diagnostics into CodeMirror
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(setDiagnostics(view.state, diagnostics ?? []));
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    scrollToLine(line: number) {
      const view = viewRef.current;
      if (!view) return;
      const clampedLine = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(clampedLine).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }),
      });
      view.focus();
    },
    format() {
      const view = viewRef.current;
      if (!view) return;
      const text = view.state.doc.toString();
      let formatted: string;
      try {
        const doc = YAML.parseDocument(text);
        formatted = doc.toString({ indent: 2, lineWidth: 0 });
      } catch {
        return;
      }
      if (formatted === text) return;
      suppressEcho.current = true;
      view.dispatch({
        changes: { from: 0, to: text.length, insert: formatted },
      });
      suppressEcho.current = false;
      onChangeRef.current(formatted);
    },
  }));

  return (
    <div ref={hostRef} className="h-full w-full overflow-auto" data-testid="setup-yaml-editor" />
  );
});

export default SetupYamlEditor;
