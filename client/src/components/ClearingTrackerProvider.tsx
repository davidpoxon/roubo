import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Loader2, Check } from "lucide-react";
import { TeardownTrackerContext, type TeardownEntry } from "../lib/teardown-tracker-context";
import { useAllBenches } from "../hooks/useBenches";
import { useToast } from "../hooks/useToast";
import { stepIcon, stepTextColor } from "../lib/provisioning";
import type { Bench } from "@roubo/shared";
import { useEntranceAnimation } from "../hooks/useEntranceAnimation";

function TeardownCard({ bench, exiting }: { bench: Bench; exiting: boolean }) {
  const visible = useEntranceAnimation();

  const steps = bench.teardownSteps ?? [];
  const currentStep = steps.find((s) => s.status === "running");
  const doneCount = steps.filter((s) => s.status === "done").length;
  const hasError = steps.some((s) => s.status === "error");

  return (
    <div
      className="transition-all duration-200 ease-out"
      style={{
        opacity: visible && !exiting ? 1 : 0,
        transform: visible && !exiting ? "translateY(0)" : "translateY(8px)",
      }}
    >
      <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 rounded-lg px-3.5 py-2.5 shadow-lg shadow-black/20 min-w-[260px] max-w-xs">
        <div className="flex items-center gap-2">
          <Loader2 size={12} className="text-amber-500 animate-spin shrink-0" />
          <span className="text-xs font-medium text-stone-800 dark:text-stone-200">
            Bench {bench.id}
          </span>
          <span className="text-[11px] font-mono text-stone-400 dark:text-stone-600 truncate">
            {bench.branch}
          </span>
          <span className="text-[11px] font-mono text-stone-400 dark:text-stone-600 ml-auto shrink-0">
            {doneCount} / {steps.length}
          </span>
        </div>
        {currentStep && (
          <div className="flex items-center gap-2 mt-1.5 pl-5">
            <span className="flex items-center justify-center w-3 shrink-0">
              {stepIcon[currentStep.status]}
            </span>
            <span className={`text-[11px] ${stepTextColor[currentStep.status]}`}>
              {currentStep.label}
            </span>
          </div>
        )}
        {hasError && (
          <div className="flex items-center gap-2 mt-1.5 pl-5">
            <span className="text-[11px] text-red-400">Teardown failed</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CompletedCard({ benchId, exiting }: { benchId: number; exiting: boolean }) {
  const visible = useEntranceAnimation();

  return (
    <div
      className="transition-all duration-200 ease-out"
      style={{
        opacity: visible && !exiting ? 1 : 0,
        transform: visible && !exiting ? "translateY(0)" : "translateY(8px)",
      }}
    >
      <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 rounded-lg px-3.5 py-2.5 shadow-lg shadow-black/20 min-w-[260px] max-w-xs">
        <div className="flex items-center gap-2">
          <Check size={12} className="text-green-500 shrink-0" />
          <span className="text-xs font-medium text-stone-800 dark:text-stone-200">
            Bench {benchId} cleared
          </span>
        </div>
      </div>
    </div>
  );
}

function scheduleTimer(
  timers: RefObject<Set<ReturnType<typeof setTimeout>>>,
  fn: () => void,
  delay: number,
) {
  const id = setTimeout(() => {
    timers.current.delete(id);
    fn();
  }, delay);
  timers.current.add(id);
}

interface CompletedEntry {
  benchId: number;
  exiting: boolean;
}

export default function TeardownTrackerProvider({ children }: { children: ReactNode }) {
  const [teardowns, setTeardowns] = useState<Map<string, TeardownEntry>>(new Map());
  const [completed, setCompleted] = useState<Map<string, CompletedEntry>>(new Map());
  const { data: benches } = useAllBenches();
  const { addToast } = useToast();
  const prevStoppingRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const teardownsRef = useRef(teardowns);
  useEffect(() => {
    teardownsRef.current = teardowns;
  }, [teardowns]);

  // Clear any pending animation timers on unmount
  useEffect(() => {
    const timers = timersRef;
    return () => {
      for (const id of timers.current) clearTimeout(id);
      timers.current.clear();
    };
  }, []);

  const register = useCallback((projectId: string, benchId: number, branch: string) => {
    const key = `${projectId}:${benchId}`;
    setTeardowns((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { projectId, benchId, branch, registeredAt: Date.now() });
      return next;
    });
  }, []);

  // Detect when registered teardowns complete (bench disappears from benches list)
  useEffect(() => {
    if (!benches) return;

    const currentStopping = new Set<string>();
    for (const bench of benches) {
      if (bench.status === "clearing") {
        currentStopping.add(`${bench.projectId}:${bench.id}`);
      }
    }

    // Check registered teardowns that were previously stopping but now gone
    for (const key of prevStoppingRef.current) {
      if (!currentStopping.has(key) && teardownsRef.current.has(key)) {
        const entry = teardownsRef.current.get(key);
        if (!entry) continue;
        // Bench completed teardown — show brief completion card then remove
        setTeardowns((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        setCompleted((prev) => {
          const next = new Map(prev);
          next.set(key, { benchId: entry.benchId, exiting: false });
          return next;
        });
        addToast(`Bench ${entry.benchId} cleared`);
        // Auto-remove completed card after brief display
        scheduleTimer(
          timersRef,
          () => {
            setCompleted((prev) => {
              const next = new Map(prev);
              const c = next.get(key);
              if (c) next.set(key, { ...c, exiting: true });
              return next;
            });
            scheduleTimer(
              timersRef,
              () => {
                setCompleted((prev) => {
                  const next = new Map(prev);
                  next.delete(key);
                  return next;
                });
              },
              200,
            );
          },
          1500,
        );
      }
    }

    prevStoppingRef.current = currentStopping;
  }, [benches, addToast]);

  // Build the active cards: match registered teardowns against current bench data
  const activeCards = useMemo(() => {
    if (!benches) return [];
    const cards: { key: string; bench: Bench }[] = [];
    for (const [key, entry] of teardowns) {
      const bench = benches.find(
        (s) => s.projectId === entry.projectId && s.id === entry.benchId && s.status === "clearing",
      );
      if (bench) cards.push({ key, bench });
    }
    return cards;
  }, [benches, teardowns]);

  const hasCards = activeCards.length > 0 || completed.size > 0;

  return (
    <TeardownTrackerContext.Provider value={{ teardowns, register }}>
      {children}
      {hasCards && (
        <div className="fixed bottom-16 right-4 z-[100] flex flex-col-reverse gap-2 pointer-events-none">
          {activeCards.map(({ key, bench }) => (
            <div key={key} className="pointer-events-auto">
              <TeardownCard bench={bench} exiting={false} />
            </div>
          ))}
          {[...completed.entries()].map(([key, entry]) => (
            <div key={key} className="pointer-events-auto">
              <CompletedCard benchId={entry.benchId} exiting={entry.exiting} />
            </div>
          ))}
        </div>
      )}
    </TeardownTrackerContext.Provider>
  );
}
