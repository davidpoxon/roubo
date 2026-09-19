import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "react-aria-components";
import { Copy, Eraser } from "lucide-react";
import type { ComponentLogLine } from "@roubo/shared";
import { fetchComponentLogs } from "../lib/api";

export default function LogStream({
  projectId,
  benchId,
  component,
}: {
  projectId: string;
  benchId: number;
  component: string;
}) {
  const [logs, setLogs] = useState<ComponentLogLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLogsRef = useRef<ComponentLogLine[]>([]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetchComponentLogs(projectId, benchId, component);
        if (active) {
          const prev = lastLogsRef.current;
          const lastNew = res.logs[res.logs.length - 1];
          const lastPrev = prev[prev.length - 1];
          if (
            res.logs.length !== prev.length ||
            lastNew?.text !== lastPrev?.text ||
            lastNew?.ts !== lastPrev?.ts
          ) {
            lastLogsRef.current = res.logs;
            setLogs(res.logs);
          }
        }
      } catch {
        /* ignore polling errors */
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [projectId, benchId, component]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(logs.map((line) => line.text).join("\n"));
  }, [logs]);

  return (
    <div className="relative group">
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <Button
          onPress={copy}
          className="p-1 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Copy size={12} />
        </Button>
        <Button
          onPress={() => setLogs([])}
          className="p-1 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Eraser size={12} />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="bg-bg-base border border-border rounded-lg p-3 font-mono text-11 leading-5 text-text-body max-h-72 overflow-auto"
      >
        {logs.length === 0 ? (
          <span className="text-text-secondary italic">Waiting for output...</span>
        ) : (
          logs.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all hover:bg-bg-hover ${
                line.source === "stderr" ? "text-danger-text" : ""
              }`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
