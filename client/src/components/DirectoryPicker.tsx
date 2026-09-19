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
        <Label className="block text-12 text-text-secondary mb-1.5">Repository path</Label>
        <div className="flex items-center gap-2">
          <Input
            onKeyDown={(e) => e.key === "Enter" && onSubmit?.()}
            placeholder="/path/to/your/repo"
            className="flex-1 rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
          />
          <Button
            onPress={handleOpen}
            className={`focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-1.5 px-3 py-2 text-12 font-medium rounded-control transition-colors shrink-0 outline-none ${
              isOpen
                ? "text-text-primary bg-bg-pressed ring-1 ring-border-control"
                : "text-text-secondary bg-bg-hover hover:bg-bg-pressed hover:text-text-primary"
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
          className="mt-2 rounded-lg bg-bg-surface border border-border overflow-hidden"
        >
          <div className="flex items-center gap-0.5 px-3 py-2 border-b border-border min-h-[36px]">
            <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto text-nowrap">
              {segments.map((seg, i) => (
                <span key={seg.path} className="flex items-center gap-0.5">
                  {i > 0 && <ChevronRight size={12} className="text-text-secondary shrink-0" />}
                  <Button
                    onPress={() => handleNavigate(seg.path)}
                    className={`focus-visible:ring-2 focus-visible:ring-focus-ring text-11 px-1 py-0.5 rounded-control hover:bg-bg-hover transition-colors outline-none ${
                      i === segments.length - 1
                        ? "text-text-body font-medium"
                        : "text-text-secondary hover:text-text-primary"
                    }`}
                  >
                    {seg.name}
                  </Button>
                </span>
              ))}
            </div>
            <Button
              onPress={() => setShowHidden(!showHidden)}
              className="p-1 rounded-control text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors outline-none shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label={showHidden ? "Hide hidden directories" : "Show hidden directories"}
            >
              {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {isLoading && (
              <div className="flex items-center gap-2 px-4 py-6 text-13 text-text-secondary">
                <Spinner />
                Loading...
              </div>
            )}

            {error && (
              <div className="px-4 py-4 text-13 text-danger-text">{(error as Error).message}</div>
            )}

            {data && !isLoading && (
              <>
                {currentPath !== "/" && (
                  <Button
                    onPress={handleGoUp}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-bg-hover transition-colors group outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <CornerLeftUp
                      size={14}
                      className="text-text-secondary group-hover:text-text-primary"
                    />
                    <span className="text-13 text-text-secondary group-hover:text-text-primary">
                      ..
                    </span>
                  </Button>
                )}

                {data.entries.length === 0 && (
                  <div className="px-4 py-6 text-13 text-text-secondary text-center">
                    No subdirectories
                  </div>
                )}

                {data.entries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => handleNavigate(entry.path)}
                    onDoubleClick={() => handleDoubleClick(entry.path, entry.hasGit)}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-bg-hover transition-colors group outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Folder
                      size={14}
                      className={
                        entry.hasGit
                          ? "text-success-text"
                          : "text-text-secondary group-hover:text-text-primary"
                      }
                    />
                    <span className="text-13 text-text-body flex-1 truncate">{entry.name}</span>
                    {entry.hasGit && (
                      <span className="text-11 font-medium bg-success-surface text-success-text rounded px-1.5 py-0.5">
                        git
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="flex items-center gap-3 px-3 py-2.5 border-t border-border">
            <p className="text-11 font-mono text-text-secondary truncate flex-1 min-w-0">
              {currentPath}
            </p>
            <Button
              onPress={() => setIsOpen(false)}
              className="text-11 text-text-secondary hover:bg-bg-hover hover:text-text-primary px-2 py-1 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Cancel
            </Button>
            <Button
              onPress={handleSelect}
              className="text-11 font-medium text-text-secondary border border-border-strong bg-bg-surface hover:bg-bg-hover hover:text-text-primary active:bg-bg-pressed px-3 py-1.5 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Select
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
