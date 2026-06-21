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
          className="p-1 rounded bg-stone-200 dark:bg-stone-800 hover:bg-stone-300 dark:hover:bg-stone-700 text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
        >
          <Copy size={11} />
        </Button>
        <Button
          onPress={() => setLogs([])}
          className="p-1 rounded bg-stone-200 dark:bg-stone-800 hover:bg-stone-300 dark:hover:bg-stone-700 text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
        >
          <Eraser size={11} />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="bg-stone-950 rounded-lg p-3 font-mono text-[11px] leading-5 text-emerald-400/70 max-h-72 overflow-auto"
      >
        {logs.length === 0 ? (
          <span className="text-stone-600 italic">Waiting for output...</span>
        ) : (
          logs.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all hover:bg-white/[0.02] ${
                line.source === "stderr" ? "text-red-400/70" : ""
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
