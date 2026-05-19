import { createElement } from "react";
import { File, FileCode, FileJson, FolderClosed } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const EXT_ICONS: Record<string, LucideIcon> = {
  yml: FileCode,
  yaml: FileCode,
  csproj: FileCode,
  sln: FileCode,
  json: FileJson,
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
};

function getIcon(path: string): LucideIcon {
  const lastSegment = path.split("/").pop() ?? "";
  if (!lastSegment.includes(".")) return FolderClosed;
  const ext = lastSegment.split(".").pop()?.toLowerCase() ?? "";
  return EXT_ICONS[ext] ?? File;
}

export default function FilePathLabel({ path, className }: { path: string; className?: string }) {
  const segments = path.split("/");
  const leading = segments.slice(0, -1);
  const last = segments[segments.length - 1];

  return (
    <span
      title={path}
      className={`inline-flex items-center gap-1.5 font-mono ${className ?? "text-[12px]"} min-w-0 max-w-full`}
    >
      {createElement(getIcon(path), { size: 14, className: "shrink-0 text-stone-500" })}
      {leading.length === 1 && (
        <span className="shrink min-w-0 truncate text-stone-500">
          {leading[0]}
          <span className="text-stone-400 dark:text-stone-600 mx-0.5">{"\u203A"}</span>
        </span>
      )}
      {leading.length > 1 && (
        <span className="shrink-0 text-stone-500">
          <span className="truncate">{leading[0]}</span>
          <span className="text-stone-400 dark:text-stone-600 mx-0.5">{"\u203A"}</span>
          <span className="text-stone-400 dark:text-stone-600">{"\u2026"}</span>
          <span className="text-stone-400 dark:text-stone-600 mx-0.5">{"\u203A"}</span>
        </span>
      )}
      <span className="shrink-[0.01] min-w-0 truncate text-stone-800 dark:text-stone-200">
        {last}
      </span>
    </span>
  );
}
