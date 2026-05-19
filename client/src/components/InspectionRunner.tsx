import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Button, TextField, Input } from "react-aria-components";
import { Play, Square, Check, X, Copy, Loader2 } from "lucide-react";
import { useInspectionRun, useStartInspection, useAbortInspection } from "../hooks/useInspection";
import { useElapsed } from "../hooks/useElapsed";

const statusConfig = {
  running: {
    icon: <Loader2 size={14} className="animate-spin text-amber-400" />,
    text: "Running",
    color: "text-amber-400",
  },
  passed: {
    icon: <Check size={14} className="text-green-400" />,
    text: "Passed",
    color: "text-green-400",
  },
  failed: { icon: <X size={14} className="text-red-400" />, text: "Failed", color: "text-red-400" },
  error: { icon: <X size={14} className="text-red-400" />, text: "Error", color: "text-red-400" },
  aborted: {
    icon: <Square size={14} className="text-stone-400" />,
    text: "Aborted",
    color: "text-stone-400",
  },
};

export default function InspectionRunner({
  projectId,
  benchId,
}: {
  projectId: string;
  benchId: number;
}) {
  const [filter, setFilter] = useState("");
  const { data: inspectionRun } = useInspectionRun(projectId, benchId);
  const startInspection = useStartInspection();
  const abortInspection = useAbortInspection();
  const scrollRef = useRef<HTMLDivElement>(null);

  const isRunning = inspectionRun?.status === "running";
  const elapsed = useElapsed(inspectionRun?.startedAt, isRunning ?? false);
  const output = useMemo(() => inspectionRun?.output ?? [], [inspectionRun?.output]);
  const outputLen = output.length;

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    const el = scrollRef.current;
    if (el && isRunning) {
      el.scrollTop = el.scrollHeight;
    }
  }, [outputLen, isRunning]);

  const handleRun = useCallback(
    (withFilter?: string) => {
      startInspection.mutate({
        projectId,
        benchId,
        filter: withFilter || undefined,
      });
    },
    [projectId, benchId, startInspection],
  );

  const handleAbort = useCallback(() => {
    abortInspection.mutate({ projectId, benchId });
  }, [projectId, benchId, abortInspection]);

  const copyOutput = useCallback(() => {
    if (output.length > 0) {
      navigator.clipboard.writeText(output.join("\n"));
    }
  }, [output]);

  const status = inspectionRun ? statusConfig[inspectionRun.status] : null;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-2">
        <TextField
          value={filter}
          onChange={setFilter}
          isDisabled={isRunning}
          aria-label="Filter tests"
          className="flex-1"
        >
          <Input
            placeholder="Filter tests (grep pattern)..."
            className="w-full px-3 py-2 text-sm bg-stone-100 dark:bg-stone-900/50 border border-stone-300 dark:border-stone-800 rounded-lg text-stone-900 dark:text-stone-200 placeholder:text-stone-400 dark:placeholder:text-stone-600 outline-none focus:border-stone-400 dark:focus:border-stone-600 transition-colors disabled:opacity-50"
          />
        </TextField>
        {isRunning ? (
          <Button
            onPress={handleAbort}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors outline-none"
          >
            <Square size={12} />
            Stop
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              onPress={() => handleRun(filter)}
              isDisabled={startInspection.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-stone-700 dark:text-stone-200 bg-stone-200 dark:bg-stone-800 hover:bg-stone-300 dark:hover:bg-stone-700 rounded-lg transition-colors outline-none disabled:opacity-50"
            >
              <Play size={12} />
              {filter ? "Run Filtered" : "Run All"}
            </Button>
          </div>
        )}
      </div>

      {/* Status bar */}
      {status && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-stone-100 dark:bg-stone-900/50">
          <div className="flex items-center gap-2">
            {status.icon}
            <span className={`text-xs font-medium ${status.color}`}>{status.text}</span>
            {inspectionRun?.filter && (
              <span className="text-[11px] text-stone-600">
                filter: <span className="font-mono text-stone-500">{inspectionRun.filter}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {elapsed && <span className="text-xs font-mono text-stone-500">{elapsed}</span>}
            {inspectionRun?.exitCode !== null &&
              inspectionRun?.exitCode !== undefined &&
              inspectionRun.status !== "running" && (
                <span
                  className={`text-[11px] font-mono ${inspectionRun.exitCode === 0 ? "text-green-500/70" : "text-red-500/70"}`}
                >
                  exit {inspectionRun.exitCode}
                </span>
              )}
          </div>
        </div>
      )}

      {/* Output */}
      <div className="relative group">
        {output.length > 0 && (
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
            <Button
              onPress={copyOutput}
              className="p-1 rounded bg-stone-200 dark:bg-stone-800 hover:bg-stone-300 dark:hover:bg-stone-700 text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none"
            >
              <Copy size={11} />
            </Button>
          </div>
        )}
        <div
          ref={scrollRef}
          className="bg-stone-950 rounded-lg p-3 font-mono text-[11px] leading-5 text-emerald-400/70 max-h-[500px] min-h-[200px] overflow-auto"
        >
          {output.length === 0 ? (
            <span className="text-stone-600 dark:text-stone-700 italic">
              {inspectionRun ? "Waiting for output..." : "Run tests to see output here"}
            </span>
          ) : (
            output.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all hover:bg-white/[0.02]">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
