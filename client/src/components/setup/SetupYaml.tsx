import { useCallback } from "react";
import * as YAML from "yaml";
import { FileText } from "lucide-react";
import { Button } from "react-aria-components";
import type { Diagnostic } from "@codemirror/lint";
import SetupYamlEditor, { type SetupYamlEditorRef } from "./SetupYamlEditor";

interface Props {
  rawYaml: string;
  onRawYamlChange: (next: string) => void;
  onSave: () => void;
  saveError?: string;
  editorRef?: React.RefObject<SetupYamlEditorRef | null>;
  diagnostics?: Diagnostic[];
  formatError?: string | null;
  onFormatErrorChange?: (err: string | null) => void;
}

export default function SetupYaml({
  rawYaml,
  onRawYamlChange,
  onSave,
  saveError,
  editorRef,
  diagnostics = [],
  formatError = null,
  onFormatErrorChange = () => {},
}: Props) {
  const handleFormat = useCallback(() => {
    onFormatErrorChange(null);
    try {
      YAML.parse(rawYaml);
    } catch {
      onFormatErrorChange("Fix YAML errors before formatting.");
      return;
    }
    editorRef?.current?.format();
  }, [rawYaml, editorRef, onFormatErrorChange]);

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950/80 overflow-hidden flex flex-col h-full min-h-[400px]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/60 shrink-0">
        <div className="flex items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500 font-mono">
          <FileText size={11} />
          roubo.yaml
        </div>
        <div className="flex items-center gap-3 text-[10px] text-stone-400 dark:text-stone-500">
          {saveError && <span className="text-red-500 dark:text-red-400">{saveError}</span>}
          {formatError && <span className="text-amber-500 dark:text-amber-400">{formatError}</span>}
          <Button
            onPress={handleFormat}
            className="hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer transition-colors outline-none data-[focus-visible]:underline"
          >
            Format
          </Button>
          <span className="font-mono select-none">
            {/Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘S" : "Ctrl+S"}
          </span>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <SetupYamlEditor
          ref={editorRef}
          value={rawYaml}
          onChange={onRawYamlChange}
          diagnostics={diagnostics}
          onSave={onSave}
        />
      </div>
    </div>
  );
}
