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
    <div className="rounded-xl border border-border bg-bg-field overflow-hidden flex flex-col h-full min-h-[400px]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg-base shrink-0">
        <div className="flex items-center gap-2 text-11 text-text-secondary font-mono">
          <FileText size={12} />
          roubo.yaml
        </div>
        <div className="flex items-center gap-3 text-11 text-text-secondary">
          {saveError && <span className="text-danger-text">{saveError}</span>}
          {formatError && <span className="text-accent-text">{formatError}</span>}
          <Button
            onPress={handleFormat}
            className="hover:text-text-primary cursor-pointer transition-colors outline-none data-[focus-visible]:underline focus-visible:ring-2 focus-visible:ring-focus-ring"
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
