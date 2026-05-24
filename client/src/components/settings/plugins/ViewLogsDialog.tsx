import { useMemo, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import { RefreshCw, X } from "lucide-react";
import type { LogLine } from "@roubo/shared";
import { usePluginLogs } from "../../../hooks/usePlugins";

type LogFile = "current" | "previous";

interface Props {
  pluginId: string;
  pluginName: string;
  isOpen: boolean;
  onClose: () => void;
}

function levelClass(level?: string): string {
  switch (level) {
    case "error":
      return "text-red-600 dark:text-red-400";
    case "warn":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-stone-500 dark:text-stone-400";
  }
}

function lineClass(line: LogLine): string {
  if (line.level === "error" || line.source === "stderr") {
    return "bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300";
  }
  return "text-stone-700 dark:text-stone-300";
}

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
  hour12: false,
});

function formatTimestamp(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return TIMESTAMP_FORMAT.format(d);
}

export default function ViewLogsDialog({ pluginId, pluginName, isOpen, onClose }: Props) {
  const [file, setFile] = useState<LogFile>("current");
  const [search, setSearch] = useState("");
  const logs = usePluginLogs(pluginId, file, isOpen);

  const filtered = useMemo(() => {
    const all = logs.data?.lines ?? [];
    if (!search.trim()) return all;
    const needle = search.toLowerCase();
    return all.filter((l) => l.text.toLowerCase().includes(needle));
  }, [logs.data, search]);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-3xl mx-4">
        <Dialog
          aria-label={`${pluginName} logs`}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-3 border-b border-stone-200 dark:border-stone-800/60 flex items-center justify-between gap-3">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {pluginName} logs
            </Heading>
            <Button
              onPress={onClose}
              aria-label="Close"
              className="p-1 rounded text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <X size={16} />
            </Button>
          </div>

          <div className="px-5 py-3 border-b border-stone-200 dark:border-stone-800/60 flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-md border border-stone-200 dark:border-stone-700 p-0.5">
              {(["current", "previous"] as LogFile[]).map((f) => (
                <Button
                  key={f}
                  data-testid={`log-file-${f}`}
                  onPress={() => setFile(f)}
                  aria-pressed={file === f}
                  className={[
                    "px-2.5 py-1 text-xs rounded transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500",
                    file === f
                      ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-medium"
                      : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200",
                  ].join(" ")}
                >
                  {f}.log
                </Button>
              ))}
            </div>

            <TextField
              autoFocus
              value={search}
              onChange={setSearch}
              aria-label="Filter log lines"
              className="flex-1"
            >
              <Label className="sr-only">Filter</Label>
              <Input
                placeholder="Filter..."
                className="w-full px-2.5 py-1 text-xs rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 placeholder:text-stone-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              />
            </TextField>

            <Button
              onPress={() => logs.refetch()}
              isDisabled={logs.isFetching}
              aria-label="Refresh logs"
              className="p-1.5 rounded text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <RefreshCw size={14} className={logs.isFetching ? "animate-spin" : ""} />
            </Button>
          </div>

          <div
            data-testid="log-content"
            className="max-h-[480px] overflow-y-auto px-2 py-2 font-mono text-[11px] leading-relaxed bg-stone-50 dark:bg-stone-950"
          >
            {logs.isLoading && (
              <p className="px-2 py-1 text-stone-500 dark:text-stone-400">Loading...</p>
            )}
            {!logs.isLoading && filtered.length === 0 && (
              <p className="px-2 py-1 text-stone-500 dark:text-stone-400">No log entries yet.</p>
            )}
            {filtered.map((line, idx) => (
              <div key={idx} className={`flex gap-2 px-2 py-0.5 rounded ${lineClass(line)}`}>
                <span
                  className="shrink-0 text-stone-400 dark:text-stone-500"
                  title={line.ts || undefined}
                >
                  {formatTimestamp(line.ts)}
                </span>
                {line.level && (
                  <span className={`shrink-0 uppercase ${levelClass(line.level)}`}>
                    {line.level}
                  </span>
                )}
                <span className="break-all whitespace-pre-wrap">{line.text}</span>
              </div>
            ))}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
