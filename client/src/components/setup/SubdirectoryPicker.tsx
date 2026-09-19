import { useState, useCallback, useEffect, useRef } from "react";
import { Button, TextField, Input } from "react-aria-components";
import { FolderOpen, Folder, ChevronRight, Eye, EyeOff, CornerLeftUp } from "lucide-react";
import { useBrowseDirectory } from "../../hooks/useFilesystem";
import FilePathLabel from "../FilePathLabel";
import Spinner from "../Spinner";

interface SubdirectoryPickerProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (relativePath: string) => void;
  basePath: string;
}

function toRelative(absolutePath: string, basePath: string): string {
  if (absolutePath === basePath) return "";
  const prefix = basePath.endsWith("/") ? basePath : basePath + "/";
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

function toAbsolute(relativePath: string, basePath: string): string {
  if (!relativePath) return basePath;
  return basePath + "/" + relativePath;
}

export default function SubdirectoryPicker({
  label,
  placeholder,
  value,
  onChange,
  basePath,
}: SubdirectoryPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, error } = useBrowseDirectory(browsePath, showHidden, isOpen);

  const currentPath = data?.path ?? browsePath ?? basePath;

  const handleOpen = useCallback(() => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    const startPath = value.trim() ? toAbsolute(value.trim(), basePath) : basePath;
    setBrowsePath(startPath);
    setIsOpen(true);
  }, [isOpen, value, basePath]);

  const handleNavigate = useCallback((dirPath: string) => {
    setBrowsePath(dirPath);
  }, []);

  const handleGoUp = useCallback(() => {
    if (!currentPath || currentPath === basePath) return;
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    if (parent.length < basePath.length) return;
    setBrowsePath(parent);
  }, [currentPath, basePath]);

  const handleSelect = useCallback(() => {
    onChange(toRelative(currentPath, basePath));
    setIsOpen(false);
  }, [currentPath, basePath, onChange]);

  const handleEntryClick = useCallback((dirPath: string) => {
    setBrowsePath(dirPath);
  }, []);

  const handleEntryDoubleClick = useCallback(
    (dirPath: string) => {
      onChange(toRelative(dirPath, basePath));
      setIsOpen(false);
    },
    [basePath, onChange],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen]);

  // Breadcrumb segments relative to basePath
  const repoName = basePath.split("/").filter(Boolean).pop() ?? "/";
  const relativeCurrent = toRelative(currentPath, basePath);
  const segments: { name: string; path: string }[] = [{ name: repoName, path: basePath }];
  if (relativeCurrent) {
    relativeCurrent.split("/").reduce((parentPath, seg) => {
      const fullPath = parentPath + "/" + seg;
      segments.push({ name: seg, path: fullPath });
      return fullPath;
    }, basePath);
  }

  const canGoUp = currentPath !== basePath;
  const hasValue = value.trim().length > 0;

  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing]);

  return (
    <div>
      <label className="block text-12 text-text-secondary mb-1.5">{label}</label>
      <div className="flex items-center gap-2">
        {hasValue && !isEditing ? (
          <Button
            onPress={() => setIsEditing(true)}
            className="flex-1 flex items-center rounded-control bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-left transition-colors hover:border-stone-400 dark:hover:border-stone-600 min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <FilePathLabel path={value} />
          </Button>
        ) : (
          <TextField value={value} onChange={onChange} aria-label={label} className="flex-1">
            <Input
              ref={inputRef}
              placeholder={placeholder}
              onBlur={() => setIsEditing(false)}
              className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
            />
          </TextField>
        )}
        <Button
          onPress={handleOpen}
          isDisabled={!basePath}
          className={`focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-1.5 px-3 py-2 text-12 font-medium rounded-control transition-colors shrink-0 outline-none ${
            isOpen
              ? "text-stone-100 bg-stone-700 ring-1 ring-border-strong"
              : "text-stone-500 dark:text-stone-400 bg-stone-200 dark:bg-stone-800/80 hover:bg-stone-300 dark:hover:bg-stone-700 hover:text-stone-700 dark:hover:text-stone-300 disabled:opacity-40 disabled:hover:bg-stone-200 dark:disabled:hover:bg-stone-800/80 disabled:hover:text-stone-500 dark:disabled:hover:text-stone-400"
          }`}
        >
          <FolderOpen size={14} />
          Browse
        </Button>
      </div>

      {isOpen && (
        <div className="mt-2 rounded-lg bg-white dark:bg-stone-900/90 border border-stone-200 dark:border-stone-700/50 overflow-hidden">
          <div className="flex items-center gap-0.5 px-3 py-2 border-b border-stone-200 dark:border-stone-800 min-h-[36px]">
            <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto text-nowrap">
              {segments.map((seg, i) => (
                <span key={seg.path} className="flex items-center gap-0.5">
                  {i > 0 && (
                    <ChevronRight
                      size={12}
                      className="text-stone-300 dark:text-stone-700 shrink-0"
                    />
                  )}
                  <Button
                    onPress={() => handleNavigate(seg.path)}
                    className={`focus-visible:ring-2 focus-visible:ring-focus-ring text-11 px-1 py-0.5 rounded-control hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none ${
                      i === segments.length - 1
                        ? "text-stone-700 dark:text-stone-300 font-medium"
                        : "text-text-secondary hover:text-stone-700 dark:hover:text-stone-300"
                    }`}
                  >
                    {seg.name}
                  </Button>
                </span>
              ))}
            </div>
            <Button
              onPress={() => setShowHidden(!showHidden)}
              className="p-1 rounded-control text-stone-500 dark:text-stone-400 hover:text-stone-600 dark:hover:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label={showHidden ? "Hide hidden directories" : "Show hidden directories"}
            >
              {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {isLoading && (
              <div className="flex items-center gap-2 px-4 py-6 text-13 text-stone-500 dark:text-stone-400">
                <Spinner />
                Loading...
              </div>
            )}

            {error && (
              <div className="px-4 py-4 text-13 text-red-400">{(error as Error).message}</div>
            )}

            {data && !isLoading && (
              <>
                {canGoUp && (
                  <Button
                    onPress={handleGoUp}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors group outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <CornerLeftUp
                      size={14}
                      className="text-stone-500 dark:text-stone-400 group-hover:text-stone-600 dark:group-hover:text-stone-400"
                    />
                    <span className="text-13 text-text-secondary group-hover:text-stone-700 dark:group-hover:text-stone-300">
                      ..
                    </span>
                  </Button>
                )}

                {data.entries.length === 0 && (
                  <div className="px-4 py-6 text-13 text-stone-500 dark:text-stone-400 text-center">
                    No subdirectories
                  </div>
                )}

                {data.entries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => handleEntryClick(entry.path)}
                    onDoubleClick={() => handleEntryDoubleClick(entry.path)}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors group outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Folder
                      size={14}
                      className="text-stone-500 dark:text-stone-400 group-hover:text-stone-500"
                    />
                    <span className="text-13 text-stone-700 dark:text-stone-300 flex-1 truncate">
                      {entry.name}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="flex items-center gap-3 px-3 py-2.5 border-t border-stone-200 dark:border-stone-800">
            <p className="text-11 font-mono text-stone-500 dark:text-stone-400 truncate flex-1 min-w-0">
              {relativeCurrent || "."}
            </p>
            <Button
              onPress={() => setIsOpen(false)}
              className="text-11 text-text-secondary hover:text-stone-700 dark:hover:text-stone-300 px-2 py-1 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Cancel
            </Button>
            <Button
              onPress={handleSelect}
              className="text-11 font-medium text-stone-100 bg-stone-700 hover:bg-stone-600 px-3 py-1.5 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Select
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
