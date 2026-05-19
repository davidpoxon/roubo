import { useState, useCallback, useEffect, useRef } from "react";
import { Button, TextField, Label, Input } from "react-aria-components";
import { FolderOpen, Folder, ChevronRight, Eye, EyeOff, CornerLeftUp } from "lucide-react";
import { useBrowseDirectory } from "../hooks/useFilesystem";
import Spinner from "./Spinner";

interface DirectoryPickerProps {
  value: string;
  onChange: (path: string) => void;
  onSubmit?: () => void;
}

export default function DirectoryPicker({ value, onChange, onSubmit }: DirectoryPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error } = useBrowseDirectory(browsePath, showHidden, isOpen);

  const currentPath = data?.path ?? browsePath ?? "";

  const handleOpen = useCallback(() => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setBrowsePath(value.trim() || undefined);
    setIsOpen(true);
  }, [isOpen, value]);

  const handleNavigate = useCallback((dirPath: string) => {
    setBrowsePath(dirPath);
  }, []);

  const handleGoUp = useCallback(() => {
    if (!currentPath || currentPath === "/") return;
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    setBrowsePath(parent);
  }, [currentPath]);

  const handleSelect = useCallback(() => {
    onChange(currentPath);
    setIsOpen(false);
  }, [currentPath, onChange]);

  const handleDoubleClick = useCallback(
    (dirPath: string, hasGit: boolean) => {
      if (hasGit) {
        onChange(dirPath);
        setIsOpen(false);
      } else {
        setBrowsePath(dirPath);
      }
    },
    [onChange],
  );

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen]);

  // Build breadcrumb segments
  const segments = currentPath
    ? currentPath.split("/").reduce<{ name: string; path: string }[]>((acc, seg, i) => {
        if (i === 0) {
          acc.push({ name: "/", path: "/" });
        } else if (seg) {
          const prev = acc[acc.length - 1];
          acc.push({ name: seg, path: prev.path === "/" ? `/${seg}` : `${prev.path}/${seg}` });
        }
        return acc;
      }, [])
    : [];

  return (
    <div>
      <TextField value={value} onChange={onChange}>
        <Label className="block text-xs text-stone-500 mb-1.5">Repository path</Label>
        <div className="flex items-center gap-2">
          <Input
            onKeyDown={(e) => e.key === "Enter" && onSubmit?.()}
            placeholder="/path/to/your/repo"
            className="flex-1 rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600"
          />
          <Button
            onPress={handleOpen}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors shrink-0 outline-none ${
              isOpen
                ? "text-stone-900 dark:text-stone-100 bg-stone-200 dark:bg-stone-700 ring-1 ring-stone-400 dark:ring-stone-600"
                : "text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800/80 hover:bg-stone-200 dark:hover:bg-stone-700 hover:text-stone-700 dark:hover:text-stone-300"
            }`}
          >
            <FolderOpen size={14} />
            Browse
          </Button>
        </div>
      </TextField>

      {isOpen && (
        <div
          ref={panelRef}
          className="mt-2 rounded-lg bg-white dark:bg-stone-900/90 border border-stone-200 dark:border-stone-700/50 overflow-hidden"
        >
          <div className="flex items-center gap-0.5 px-3 py-2 border-b border-stone-200 dark:border-stone-800 min-h-[36px]">
            <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto text-nowrap">
              {segments.map((seg, i) => (
                <span key={seg.path} className="flex items-center gap-0.5">
                  {i > 0 && (
                    <ChevronRight
                      size={10}
                      className="text-stone-300 dark:text-stone-700 shrink-0"
                    />
                  )}
                  <Button
                    onPress={() => handleNavigate(seg.path)}
                    className={`text-[11px] px-1 py-0.5 rounded hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none ${
                      i === segments.length - 1
                        ? "text-stone-700 dark:text-stone-300 font-medium"
                        : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
                    }`}
                  >
                    {seg.name}
                  </Button>
                </span>
              ))}
            </div>
            <Button
              onPress={() => setShowHidden(!showHidden)}
              className="p-1 rounded text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none shrink-0"
              aria-label={showHidden ? "Hide hidden directories" : "Show hidden directories"}
            >
              {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {isLoading && (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-stone-400 dark:text-stone-600">
                <Spinner />
                Loading...
              </div>
            )}

            {error && (
              <div className="px-4 py-4 text-sm text-red-400">{(error as Error).message}</div>
            )}

            {data && !isLoading && (
              <>
                {currentPath !== "/" && (
                  <Button
                    onPress={handleGoUp}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800/60 transition-colors group outline-none"
                  >
                    <CornerLeftUp
                      size={14}
                      className="text-stone-400 dark:text-stone-600 group-hover:text-stone-600 dark:group-hover:text-stone-400"
                    />
                    <span className="text-sm text-stone-500 group-hover:text-stone-700 dark:group-hover:text-stone-300">
                      ..
                    </span>
                  </Button>
                )}

                {data.entries.length === 0 && (
                  <div className="px-4 py-6 text-sm text-stone-300 dark:text-stone-700 text-center">
                    No subdirectories
                  </div>
                )}

                {data.entries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => handleNavigate(entry.path)}
                    onDoubleClick={() => handleDoubleClick(entry.path, entry.hasGit)}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800/60 transition-colors group"
                  >
                    <Folder
                      size={14}
                      className={
                        entry.hasGit
                          ? "text-emerald-500/70"
                          : "text-stone-400 dark:text-stone-600 group-hover:text-stone-500"
                      }
                    />
                    <span className="text-sm text-stone-700 dark:text-stone-300 flex-1 truncate">
                      {entry.name}
                    </span>
                    {entry.hasGit && (
                      <span className="text-[10px] font-medium bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 rounded px-1.5 py-0.5">
                        git
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="flex items-center gap-3 px-3 py-2.5 border-t border-stone-200 dark:border-stone-800">
            <p className="text-[11px] font-mono text-stone-400 dark:text-stone-600 truncate flex-1 min-w-0">
              {currentPath}
            </p>
            <Button
              onPress={() => setIsOpen(false)}
              className="text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 px-2 py-1 rounded transition-colors outline-none"
            >
              Cancel
            </Button>
            <Button
              onPress={handleSelect}
              className="text-[11px] font-medium text-white dark:text-stone-100 bg-stone-700 hover:bg-stone-600 dark:hover:bg-stone-600 px-3 py-1.5 rounded-md transition-colors outline-none"
            >
              Select
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
