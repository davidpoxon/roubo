import { useCallback, useRef, useState, useEffect, type ReactNode } from "react";
import { Button } from "react-aria-components";
import { ToastContext, type ToastAction, type ToastOptions } from "../lib/toast-context";
import { useEntranceAnimation } from "../hooks/useEntranceAnimation";

interface ToastEntry {
  id: string;
  message: string;
  action?: ToastAction;
  duration: number;
  exiting: boolean;
}

let nextId = 0;

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: (id: string, expired: boolean) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = useEntranceAnimation();

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      onDismiss(toast.id, true);
    }, toast.duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.duration, onDismiss]);

  const handleAction = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    toast.action?.onPress();
    onDismiss(toast.id, false);
  };

  return (
    <div
      className="transition-all duration-200 ease-out"
      style={{
        opacity: visible && !toast.exiting ? 1 : 0,
        transform: visible && !toast.exiting ? "translateY(0)" : "translateY(8px)",
      }}
    >
      <div className="flex items-center gap-3 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 rounded-lg px-4 py-2.5 shadow-lg shadow-black/10 dark:shadow-black/20">
        <p className="text-sm text-stone-800 dark:text-stone-200 min-w-0 truncate">
          {toast.message}
        </p>
        {toast.action && (
          <Button
            onPress={handleAction}
            className="shrink-0 text-xs font-medium text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-100 transition-colors outline-none px-1.5 py-0.5 rounded"
          >
            {toast.action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const toastCallbacksRef = useRef(new Map<string, (() => void) | undefined>());
  const animationTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = animationTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastCallbacksRef.current.delete(id);
      animationTimers.current.delete(id);
    }, 200);
    animationTimers.current.set(id, timer);
  }, []);

  const handleDismiss = useCallback(
    (id: string, expired: boolean) => {
      if (expired) {
        const onExpire = toastCallbacksRef.current.get(id);
        onExpire?.();
      }
      removeToast(id);
    },
    [removeToast],
  );

  const addToast = useCallback((message: string, options?: ToastOptions) => {
    const id = `toast-${++nextId}`;
    const entry: ToastEntry = {
      id,
      message,
      action: options?.action,
      duration: options?.duration ?? 3000,
      exiting: false,
    };
    toastCallbacksRef.current.set(id, options?.onExpire);
    setToasts((prev) => [...prev, entry]);
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 max-w-sm pointer-events-none">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <Toast toast={toast} onDismiss={handleDismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
