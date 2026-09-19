import { useRef, useEffect, useCallback } from "react";
import { Input } from "react-aria-components";

interface TextSegment {
  text: string;
  isVariable: boolean;
}

function parseSegments(value: string): TextSegment[] {
  if (!value) return [];
  return value
    .split(/({{[^}]*}})/)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      isVariable: /^{{[^}]*}}$/.test(part),
    }));
}

import { INPUT, INPUT_INNER } from "./styles";

interface Props {
  value: string;
  placeholder?: string;
  className?: string;
  variant?: "standalone" | "inner";
  invalidVariables?: string[];
}

export default function TemplateHighlightInput({
  value,
  placeholder,
  className,
  variant = "standalone",
  invalidVariables,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const segments = parseSegments(value);
  const hasVariables = segments.some((s) => s.isVariable);

  const syncScroll = useCallback(() => {
    if (inputRef.current && backdropRef.current) {
      backdropRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.addEventListener("scroll", syncScroll);
    return () => input.removeEventListener("scroll", syncScroll);
  }, [syncScroll]);

  useEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  const baseClass = variant === "standalone" ? INPUT : INPUT_INNER;

  return (
    <div className={`relative ${variant === "inner" ? "flex-1 min-w-0" : ""} ${className ?? ""}`}>
      {hasVariables && (
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`absolute inset-0 pointer-events-none overflow-hidden flex items-center ${
            variant === "standalone" ? "px-3 py-2" : "p-0"
          }`}
        >
          <div className="whitespace-pre text-13">
            {segments.map((seg, i) =>
              seg.isVariable ? (
                <span
                  key={i}
                  className={`rounded-sm ${
                    invalidVariables?.includes(seg.text)
                      ? "text-danger-text bg-danger-surface"
                      : "text-accent-text bg-accent-muted"
                  }`}
                >
                  {seg.text}
                </span>
              ) : (
                <span key={i} className="text-text-primary">
                  {seg.text}
                </span>
              ),
            )}
          </div>
        </div>
      )}
      <Input
        ref={inputRef}
        placeholder={placeholder}
        className={`${baseClass} ${hasVariables ? "!text-transparent caret-text-secondary" : ""}`}
      />
    </div>
  );
}

export function TemplateValidationError({ invalidVariables }: { invalidVariables: string[] }) {
  if (invalidVariables.length === 0) return null;
  return (
    <p className="mt-1 text-11 text-danger-text">
      Unknown {invalidVariables.length === 1 ? "variable" : "variables"}:{" "}
      {invalidVariables.join(", ")}
    </p>
  );
}
