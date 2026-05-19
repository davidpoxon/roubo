import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useNavigate, useBlocker } from "react-router-dom";
import {
  TextField,
  Label,
  Input,
  Button,
  TextArea,
  Tabs,
  TabList,
  Tab,
  TabPanel,
} from "react-aria-components";
import type { BlueprintDetail, BlueprintReference } from "@roubo/shared";
import { GLOBAL_DEFAULT_BLUEPRINT_ID, DEFAULT_CONTEXT_WINDOW } from "@roubo/shared";
import { INPUT } from "../setup/styles";
import {
  useCreateGlobalBlueprint,
  useUpdateGlobalBlueprint,
  useDeleteGlobalBlueprint,
  useCreateProjectBlueprint,
  useUpdateProjectBlueprint,
  useDeleteProjectBlueprint,
} from "../../hooks/useBlueprints";
import { ApiError, isBlueprintReferencedError } from "../../lib/api";
import { useToast } from "../../hooks/useToast";
import { useSettings } from "../../hooks/useSettings";
import BlueprintMarkdownEditor, {
  type BlueprintMarkdownEditorRef,
} from "./BlueprintMarkdownEditor";
import BlueprintPreviewPanel from "./BlueprintPreviewPanel";
import VariableInsertionPanel from "./VariableInsertionPanel";
import BlueprintIconPicker from "./BlueprintIconPicker";
import BlueprintIcon from "./BlueprintIcon";
import UnsavedChangesDialog from "./UnsavedChangesDialog";
import DeleteBlueprintDialog from "./DeleteBlueprintDialog";
import { DEFAULT_BLUEPRINT_ICON } from "./blueprintIcons";

const SOFT_WARN_BYTES = 50 * 1024;
const HARD_LIMIT_BYTES = 200 * 1024;
const encoder = new TextEncoder();

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`;
  return n.toLocaleString();
}

function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

interface Props {
  initial?: BlueprintDetail;
  scope: "global" | "project";
  mode: "create" | "edit";
  projectId?: string;
}

const tabClassName = ({ isSelected }: { isSelected: boolean }) =>
  `px-3 py-2 text-xs font-medium transition-colors outline-none cursor-default border-b-2 -mb-px ${
    isSelected
      ? "text-stone-800 dark:text-stone-200 border-amber-500"
      : "text-stone-500 dark:text-stone-600 border-transparent hover:text-stone-700 dark:hover:text-stone-400"
  }`;

export default function BlueprintEditorForm({ initial, scope, mode, projectId }: Props) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { settings } = useSettings();
  const editorRef = useRef<BlueprintMarkdownEditorRef>(null);
  const justSavedRef = useRef(false);

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? DEFAULT_BLUEPRINT_ICON);
  const [content, setContent] = useState(initial?.content ?? "");
  const [errors, setErrors] = useState<{
    name?: string;
    description?: string;
    content?: string;
    root?: string;
  }>({});
  const [showDelete, setShowDelete] = useState(false);
  const [deleteReferences, setDeleteReferences] = useState<BlueprintReference[] | undefined>();

  const isProject = scope === "project";
  const backHref = isProject && projectId ? `/projects/${projectId}/settings` : "/settings";
  const breadcrumbLabel = isProject ? "Project settings" : "Settings";

  const createGlobal = useCreateGlobalBlueprint();
  const updateGlobal = useUpdateGlobalBlueprint();
  const removeGlobal = useDeleteGlobalBlueprint();
  const createProject = useCreateProjectBlueprint(projectId);
  const updateProject = useUpdateProjectBlueprint(projectId);
  const removeProject = useDeleteProjectBlueprint(projectId);

  const create = isProject ? createProject : createGlobal;
  const update = isProject ? updateProject : updateGlobal;
  const remove = isProject ? removeProject : removeGlobal;

  const isDirty = useMemo(
    () =>
      (initial?.name ?? "") !== name ||
      (initial?.description ?? "") !== description ||
      (initial?.icon ?? DEFAULT_BLUEPRINT_ICON) !== icon ||
      (initial?.content ?? "") !== content,
    [initial, name, description, icon, content],
  );

  const contentBytes = useMemo(() => encoder.encode(content).length, [content]);
  const sizeSoftWarn = contentBytes >= SOFT_WARN_BYTES;
  const sizeHardError = contentBytes > HARD_LIMIT_BYTES;

  const contextWindow = settings?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const approxTokens = useMemo(() => Math.ceil(contentBytes / 4), [contentBytes]);
  const tokenPercent = useMemo(
    () => (approxTokens === 0 ? 0 : Math.max(1, Math.round((approxTokens / contextWindow) * 100))),
    [approxTokens, contextWindow],
  );

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && !justSavedRef.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const handleInsert = useCallback((syntax: string) => {
    editorRef.current?.insertAtCursor(syntax);
  }, []);

  const mapError = useCallback(
    (err: unknown) => {
      if (!(err instanceof ApiError)) {
        setErrors({ root: "An unexpected error occurred. Please try again." });
        return;
      }
      const code = err.code;
      if (code === "INVALID_NAME") {
        setErrors({ name: err.message });
      } else if (code === "INVALID_DESCRIPTION") {
        setErrors({ description: err.message });
      } else if (code === "INVALID_CONTENT") {
        setErrors({ content: err.message });
      } else if (code === "DUPLICATE_NAME" || code === "DUPLICATE_ID") {
        setErrors({ name: "Another blueprint already uses this name." });
      } else {
        setErrors({ root: err.message });
        addToast(err.message);
      }
    },
    [addToast],
  );

  const validateLocal = useCallback((): boolean => {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Name is required.";
    else if (name.trim().length > 100) next.name = "Name must be 100 characters or fewer.";
    if (!description.trim()) next.description = "Description is required.";
    else if (description.trim().length > 300)
      next.description = "Description must be 300 characters or fewer.";
    if (!content.trim()) next.content = "Content is required.";
    if (sizeHardError)
      next.content = `Content exceeds the 200 KB limit (${formatBytes(contentBytes)}).`;
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [name, description, content, contentBytes, sizeHardError]);

  const handleSave = useCallback(async () => {
    if (!validateLocal()) return;
    const body = {
      name: name.trim(),
      description: description.trim(),
      icon,
      content,
    };
    try {
      if (mode === "create") {
        await create.mutateAsync(body);
      } else {
        await update.mutateAsync({ id: initial?.id ?? "", body });
      }
      justSavedRef.current = true;
      addToast("Blueprint saved.");
      navigate(backHref);
    } catch (err) {
      mapError(err);
    }
  }, [
    validateLocal,
    name,
    description,
    icon,
    content,
    mode,
    create,
    update,
    initial,
    addToast,
    navigate,
    backHref,
    mapError,
  ]);

  const handleCancel = useCallback(() => {
    navigate(backHref);
  }, [navigate, backHref]);

  const handleDelete = useCallback(async () => {
    try {
      await remove.mutateAsync(initial?.id ?? "");
      setShowDelete(false);
      justSavedRef.current = true;
      addToast("Blueprint deleted.");
      navigate(backHref);
    } catch (err) {
      if (isBlueprintReferencedError(err)) {
        setDeleteReferences(err.details.references);
      } else if (err instanceof ApiError) {
        addToast(err.message);
        setShowDelete(false);
      } else {
        addToast("An unexpected error occurred. Please try again.");
        setShowDelete(false);
      }
    }
  }, [remove, initial, addToast, navigate, backHref]);

  const isPending = create.isPending || update.isPending;
  const saveDisabled = isPending || sizeHardError;

  const blueprintId = mode === "create" ? slugify(name) : (initial?.id ?? "");

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Top action bar */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-stone-200 dark:border-stone-800/60 shrink-0">
          <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
            <Button
              onPress={handleCancel}
              className="hover:text-stone-700 dark:hover:text-stone-200 transition-colors duration-150 outline-none focus-visible:underline"
            >
              {breadcrumbLabel}
            </Button>
            <span>/</span>
            <span className="flex items-center gap-1.5 text-stone-700 dark:text-stone-300 font-medium">
              <BlueprintIcon name={icon} size={14} className="text-stone-500 dark:text-stone-400" />
              {mode === "create" ? "New blueprint" : (initial?.name ?? "Edit blueprint")}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mode === "edit" && initial?.id !== GLOBAL_DEFAULT_BLUEPRINT_ID && (
              <Button
                onPress={() => {
                  setDeleteReferences(undefined);
                  setShowDelete(true);
                }}
                className="px-3 py-1.5 text-sm text-red-500 hover:text-red-400 transition-colors rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-red-400"
              >
                Delete
              </Button>
            )}
            <Button
              onPress={handleCancel}
              className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
            >
              Cancel
            </Button>
            <Button
              onPress={handleSave}
              isDisabled={saveDisabled}
              className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
            >
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left column — metadata */}
          <div className="w-64 shrink-0 border-r border-stone-200 dark:border-stone-800/60 overflow-auto px-5 py-6 space-y-5">
            {/* Icon + Name */}
            <div className="space-y-2">
              <Label className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                Name
              </Label>
              <div className="flex items-center gap-2">
                <BlueprintIconPicker value={icon} onChange={setIcon} />
                <TextField
                  aria-label="Blueprint name"
                  value={name}
                  onChange={setName}
                  isInvalid={!!errors.name}
                  className="flex-1"
                >
                  <Input className={INPUT} placeholder="My blueprint" />
                </TextField>
              </div>
              {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
              {mode === "edit" && blueprintId && (
                <p className="text-[10px] font-mono text-stone-400 dark:text-stone-600 leading-relaxed">
                  ID: {blueprintId} · stays the same even if the name changes
                </p>
              )}
              {mode === "create" && blueprintId && (
                <p className="text-[10px] font-mono text-stone-400 dark:text-stone-600">
                  ID will be: {blueprintId}
                </p>
              )}
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                Description
              </Label>
              <TextField
                aria-label="Blueprint description"
                value={description}
                onChange={setDescription}
                isInvalid={!!errors.description}
              >
                <TextArea
                  className={`${INPUT} resize-none h-20`}
                  placeholder="What this blueprint does"
                />
              </TextField>
              {errors.description && <p className="text-xs text-red-500">{errors.description}</p>}
            </div>

            {/* Size indicator */}
            <div className="space-y-1">
              <p
                className={`text-[10px] font-mono ${
                  sizeHardError
                    ? "text-red-500"
                    : sizeSoftWarn
                      ? "text-amber-500"
                      : "text-stone-400 dark:text-stone-600"
                }`}
              >
                {formatBytes(contentBytes)} / 200 KB
              </p>
              <p className="text-[10px] font-mono text-stone-400 dark:text-stone-600">
                ~{approxTokens.toLocaleString()} tokens · {tokenPercent}% of{" "}
                {formatContextWindow(contextWindow)} context
              </p>
              {sizeHardError && (
                <p className="text-[10px] text-red-500">
                  Content exceeds the 200 KB limit ({formatBytes(contentBytes)}
                  ).
                </p>
              )}
              {sizeSoftWarn && !sizeHardError && (
                <p className="text-[10px] text-amber-500">
                  Large blueprint — will consume ~{tokenPercent}% of the context window per run.
                </p>
              )}
            </div>

            {errors.content && !sizeHardError && (
              <p className="text-xs text-red-500">{errors.content}</p>
            )}

            {errors.root && <p className="text-xs text-red-500">{errors.root}</p>}
          </div>

          {/* Centre column — editor / preview */}
          <div className="flex-1 min-w-0 flex flex-col p-5">
            <Tabs className="flex flex-col flex-1 min-h-0">
              <TabList className="flex gap-1 border-b border-stone-200 dark:border-stone-800/60 mb-3">
                <Tab id="edit" className={tabClassName}>
                  Edit
                </Tab>
                <Tab id="preview" className={tabClassName}>
                  Preview
                </Tab>
              </TabList>
              <TabPanel id="edit" className="outline-none flex-1 min-h-0">
                <BlueprintMarkdownEditor
                  ref={editorRef}
                  value={content}
                  onChange={setContent}
                  ariaLabel="Blueprint markdown content"
                />
              </TabPanel>
              <TabPanel id="preview" className="outline-none flex-1 min-h-0">
                <BlueprintPreviewPanel content={content} scope={scope} projectId={projectId} />
              </TabPanel>
            </Tabs>
          </div>

          {/* Right column — variable panel */}
          <div className="w-52 shrink-0 border-l border-stone-200 dark:border-stone-800/60">
            <VariableInsertionPanel scope={scope} onInsert={handleInsert} />
          </div>
        </div>
      </div>

      <UnsavedChangesDialog
        isOpen={blocker.state === "blocked"}
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />

      {initial && (
        <DeleteBlueprintDialog
          isOpen={showDelete}
          blueprint={initial}
          onCancel={() => {
            setShowDelete(false);
            setDeleteReferences(undefined);
          }}
          onConfirm={handleDelete}
          references={deleteReferences}
          isPending={remove.isPending}
        />
      )}
    </>
  );
}
