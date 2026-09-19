import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Button, TextField, Input } from "react-aria-components";
import { Play, Square, Check, X, Copy, Loader2 } from "lucide-react";
import { useInspectionRun, useStartInspection, useAbortInspection } from "../hooks/useInspection";
import { useElapsed } from "../hooks/useElapsed";

const statusConfig = {
  running: {
    icon: <Loader2 size={14} className="animate-spin text-status-preparing" />,
    text: "Running",
    color: "text-text-body",
  },
  passed: {
    icon: <Check size={14} className="text-status-active" />,
    text: "Passed",
    color: "text-success-text",
  },
  failed: {
    icon: <X size={14} className="text-status-error" />,
    text: "Failed",
    color: "text-danger-text",
  },
  error: {
    icon: <X size={14} className="text-status-error" />,
    text: "Error",
    color: "text-danger-text",
  },
  aborted: {
    icon: <Square size={14} className="text-text-secondary" />,
    text: "Aborted",
    color: "text-text-secondary",
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
            className="w-full px-3 py-2 text-13 bg-bg-field border border-border-control rounded-control text-text-primary placeholder:text-text-secondary outline-none focus:border-focus-ring transition-colors disabled:opacity-40 focus:ring-2 focus:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
          />
        </TextField>
        {isRunning ? (
          <Button
            onPress={handleAbort}
            className="flex items-center gap-1.5 px-4 py-2 text-12 font-medium border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <Square size={12} />
            Stop
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              onPress={() => handleRun(filter)}
              isDisabled={startInspection.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-12 font-medium border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary rounded-control transition-colors outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Play size={12} />
              {filter ? "Run Filtered" : "Run All"}
            </Button>
          </div>
        )}
      </div>

      {/* Status bar */}
      {status && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg border border-border bg-bg-surface">
          <div className="flex items-center gap-2">
            {status.icon}
            <span className={`text-12 font-medium ${status.color}`}>{status.text}</span>
            {inspectionRun?.filter && (
              <span className="text-11 text-text-secondary">
                filter:{" "}
                <span className="font-mono text-text-secondary">{inspectionRun.filter}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {elapsed && <span className="text-12 font-mono text-text-secondary">{elapsed}</span>}
            {inspectionRun?.exitCode !== null &&
              inspectionRun?.exitCode !== undefined &&
              inspectionRun.status !== "running" && (
                <span
                  className={`text-11 font-mono ${inspectionRun.exitCode === 0 ? "text-success-text" : "text-danger-text"}`}
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
              className="p-1 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Copy size={12} />
            </Button>
          </div>
        )}
        <div
          ref={scrollRef}
          className="bg-bg-base border border-border rounded-lg p-3 font-mono text-11 leading-5 text-text-body max-h-[500px] min-h-[200px] overflow-auto"
        >
          {output.length === 0 ? (
            <span className="text-text-secondary italic">
              {inspectionRun ? "Waiting for output..." : "Run tests to see output here"}
            </span>
          ) : (
            output.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all hover:bg-bg-hover">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
