import { useState, useEffect, useRef, useMemo } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import type { Bench } from "@roubo/shared";
import { lightTheme, darkTheme, variableHighlightPlugin } from "./codemirrorTheme";
import { useJigPreview } from "../../hooks/useJigs";
import { useProjectBenches } from "../../hooks/useBenches";
import { useProjects } from "../../hooks/useProjects";
import Select from "../Select";

interface Props {
  content: string;
  scope: "global" | "project";
  projectId?: string;
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function benchOptionKey(bench: Bench): string {
  return `bench:${bench.projectId}:${bench.id}`;
}

function parseBenchKey(key: string): { projectId: string; benchId: number } | null {
  if (!key.startsWith("bench:")) return null;
  const rest = key.slice("bench:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;
  const projectId = rest.slice(0, lastColon);
  const benchId = parseInt(rest.slice(lastColon + 1), 10);
  if (!projectId || isNaN(benchId)) return null;
  return { projectId, benchId };
}

function benchLabel(bench: Bench, projectPrefix: string): string {
  const base = `Bench ${bench.id}: ${bench.branch}`;
  const label = projectPrefix ? `${projectPrefix} · ${base}` : base;
  if (bench.assignedIssue) {
    return `${label} · #${bench.assignedIssue.number} ${bench.assignedIssue.title}`;
  }
  return label;
}

function ReadonlyMarkdownViewer({ value }: { value: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const initialValueRef = useRef(value);

  useEffect(() => {
    if (!hostRef.current) return;
    const initialTheme = isDark() ? darkTheme : lightTheme;

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          markdown(),
          EditorView.lineWrapping,
          EditorView.editable.of(false),
          themeCompartment.current.of(initialTheme),
          variableHighlightPlugin,
        ],
      }),
    });

    viewRef.current = view;

    const observer = new MutationObserver(() => {
      view.dispatch({
        effects: themeCompartment.current.reconfigure(isDark() ? darkTheme : lightTheme),
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      observer.disconnect();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full overflow-auto rounded-lg border border-stone-200 dark:border-stone-800/60"
      data-testid="jig-readonly-viewer"
    />
  );
}

export default function JigPreviewPanel({ content, scope, projectId }: Props) {
  const [selectedKey, setSelectedKey] = useState("sample");

  // For project scope, pass projectId to get only that project's benches.
  // For global scope, pass undefined to get all benches across all projects.
  const { data: benches } = useProjectBenches(scope === "project" ? projectId : undefined);
  const { data: projects } = useProjects();

  const parsed = useMemo(() => parseBenchKey(selectedKey), [selectedKey]);

  const { data, isPending, isError } = useJigPreview({
    content,
    projectId: parsed?.projectId,
    benchId: parsed?.benchId,
  });

  const projectNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) {
      map.set(project.id, project.config?.project?.displayName ?? project.id);
    }
    return map;
  }, [projects]);

  const contextItems = useMemo(() => {
    const items: { value: string; label: string }[] = [{ value: "sample", label: "Sample values" }];
    for (const bench of benches ?? []) {
      const prefix =
        scope === "global" ? (projectNameMap.get(bench.projectId) ?? bench.projectId) : "";
      items.push({ value: benchOptionKey(bench), label: benchLabel(bench, prefix) });
    }
    return items;
  }, [benches, projectNameMap, scope]);

  const unresolvedVars = data?.unresolvedVariables ?? [];
  const showUnresolved = unresolvedVars.length > 0;

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Context picker */}
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 shrink-0">
          Context
        </span>
        <Select
          items={contextItems}
          value={selectedKey}
          onChange={setSelectedKey}
          placeholder="Preview context source"
        />
      </div>

      {/* Unresolved variable warning: live region always rendered so screen readers
          announce changes when variables appear/disappear as the user types. */}
      <div aria-live="polite">
        {showUnresolved && (
          <div
            className="shrink-0 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 px-3 py-2"
            data-testid="unresolved-variables-banner"
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400 shrink-0 mt-px">
              Unresolved
            </span>
            <span className="text-[11px] font-mono text-amber-700 dark:text-amber-300 leading-relaxed">
              {unresolvedVars.slice(0, 3).join(", ")}
              {unresolvedVars.length > 3 && ` +${unresolvedVars.length - 3} more`}
            </span>
          </div>
        )}
      </div>

      {/* Preview surface */}
      <div className="flex-1 min-h-0">
        {isPending && content.trim().length > 0 && (
          <div className="h-full rounded-lg border border-stone-200 dark:border-stone-800/60 flex items-center justify-center">
            <span className="text-xs text-stone-400 dark:text-stone-600">Generating preview…</span>
          </div>
        )}
        {isError && (
          <div className="h-full rounded-lg border border-stone-200 dark:border-stone-800/60 flex items-center justify-center">
            <span className="text-xs text-stone-400 dark:text-stone-600">
              Failed to generate preview.
            </span>
          </div>
        )}
        {!isPending && !isError && data && <ReadonlyMarkdownViewer value={data.resolved} />}
        {!isPending && !isError && !data && (
          <div className="h-full rounded-lg border border-stone-200 dark:border-stone-800/60 flex items-center justify-center">
            <span className="text-xs text-stone-400 dark:text-stone-600">
              Start typing to see a preview.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
