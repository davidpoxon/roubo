import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import type { InputChangedEvent } from "@roubo/shared";
import {
  INPUT_NOTICE_TIMEOUT_MS,
  inputNoticeText,
  sameInputTarget,
  subscribeInputChanged,
} from "../lib/input-changed";

interface Notice {
  id: number;
  event: InputChangedEvent;
  text: string;
}

/**
 * The notices of watched input changes (HR-FR-016, HR-US-008). Each is one
 * line, never a modal: no backdrop, no focus trap, and only the notices take
 * pointer events, so the screen beneath stays usable. An applied or refused
 * notice goes after INPUT_NOTICE_TIMEOUT_MS; a rejected one stays until it is
 * dismissed or a later applied change of the same target clears it.
 */
export default function InputChangeNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  useEffect(() => {
    const pending = timers.current;
    const unsubscribe = subscribeInputChanged((event) => {
      const id = ++nextId.current;
      setNotices((prev) => {
        // A valid save clears the rejected notice of the same target.
        const kept =
          event.outcome === "applied"
            ? prev.filter(
                (n) => !(n.event.outcome === "rejected" && sameInputTarget(n.event, event)),
              )
            : prev;
        return [...kept, { id, event, text: inputNoticeText(event) }];
      });
      if (event.outcome !== "rejected") {
        pending.set(
          id,
          setTimeout(() => {
            pending.delete(id);
            setNotices((prev) => prev.filter((n) => n.id !== id));
          }, INPUT_NOTICE_TIMEOUT_MS),
        );
      }
    });
    return () => {
      unsubscribe();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <div
      aria-live="polite"
      data-testid="input-change-notices"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] flex flex-col gap-2 max-w-xl pointer-events-none"
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          role="status"
          data-outcome={notice.event.outcome}
          className="pointer-events-auto flex items-center gap-3 bg-bg-surface border border-border rounded-control px-4 py-2.5 shadow-elevation-0"
        >
          <p className="text-13 text-text-primary min-w-0 truncate" title={notice.text}>
            {notice.text}
          </p>
          <Button
            onPress={() => dismiss(notice.id)}
            aria-label="Dismiss"
            className="shrink-0 text-12 font-medium text-text-secondary hover:text-text-primary transition-colors outline-none px-1.5 py-0.5 rounded-control focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
