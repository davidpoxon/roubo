import { useState, useMemo } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { useProjects } from "../../hooks/useProjects";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../lib/api";
import Select from "../Select";
import { PermissionsRulesTable } from "./PermissionsRulesTable";
import { flattenPermissions } from "./permissionsTable";
import { ruleKey, permissionsDiff, mergeWithSelection } from "./permissionsDiff";
import type { ProjectPermissions } from "@roubo/shared";
import type { PermissionRule } from "./permissionTypes";

interface ImportPermissionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProjectId: string;
  currentPermissions: ProjectPermissions;
  onImport: (rules: PermissionRule[]) => void;
}

function projectDisplayName(repoPath: string): string {
  return repoPath.split("/").filter(Boolean).pop() ?? repoPath;
}

export function ImportPermissionsModal({
  isOpen,
  onClose,
  currentProjectId,
  currentPermissions,
  onImport,
}: ImportPermissionsModalProps) {
  const { data: projects } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const otherProjects = (projects ?? []).filter((p) => p.id !== currentProjectId);

  const {
    data: sourcePermissions,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["project-permissions", selectedProjectId],
    queryFn: () => api.fetchProjectPermissions(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const currentFlat = useMemo(() => flattenPermissions(currentPermissions), [currentPermissions]);
  const sourceRules = useMemo(
    () => (sourcePermissions ? flattenPermissions(sourcePermissions) : []),
    [sourcePermissions],
  );
  const { newRules } = useMemo(
    () => permissionsDiff(sourceRules, currentFlat),
    [sourceRules, currentFlat],
  );
  const { merged, addedKeys } = useMemo(
    () => mergeWithSelection(currentFlat, newRules, selectedKeys),
    [currentFlat, newRules, selectedKeys],
  );

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = newRules.length > 0 && selectedKeys.size === newRules.length;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(newRules.map(ruleKey)));
    }
  };

  const handleProjectChange = (id: string) => {
    setSelectedProjectId(id || null);
    setSelectedKeys(new Set());
  };

  const handleImport = () => {
    onImport(newRules.filter((r) => selectedKeys.has(ruleKey(r))));
    onClose();
  };

  const handleClose = () => {
    setSelectedProjectId(null);
    setSelectedKeys(new Set());
    onClose();
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <Modal className="w-full max-w-5xl">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {() => (
            <>
              {/* Header */}
              <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <div className="flex items-center gap-4">
                  <Heading className="text-sm font-semibold text-stone-900 dark:text-stone-100 shrink-0">
                    Import from project
                  </Heading>
                  <div className="w-56">
                    <Select
                      items={otherProjects.map((p) => ({
                        value: p.id,
                        label: projectDisplayName(p.repoPath),
                      }))}
                      value={selectedProjectId ?? ""}
                      onChange={handleProjectChange}
                      placeholder="Choose a project…"
                    />
                  </div>
                </div>
                <Button
                  onPress={handleClose}
                  aria-label="Close"
                  className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 outline-none text-[18px] leading-none transition-colors shrink-0"
                >
                  ×
                </Button>
              </div>

              {/* Body: two-panel */}
              <div className="grid grid-cols-2 divide-x divide-stone-200 dark:divide-stone-800/60">
                {/* Left: new rules picker */}
                <div className="px-5 py-4 space-y-3 min-h-[320px]">
                  <div className="flex items-center justify-between h-5">
                    <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                      {selectedProjectId && !isLoading && newRules.length > 0
                        ? `New rules (${newRules.length})`
                        : "New rules"}
                    </span>
                    {selectedProjectId && !isLoading && newRules.length > 0 && (
                      <Button
                        onPress={toggleSelectAll}
                        className="text-[11px] text-amber-500 hover:text-amber-400 outline-none transition-colors"
                      >
                        {allSelected ? "Deselect all" : "Select all"}
                      </Button>
                    )}
                  </div>

                  {!selectedProjectId ? (
                    <p className="text-[12px] text-stone-400 dark:text-stone-500 py-8 text-center">
                      {otherProjects.length === 0
                        ? "No other registered projects found."
                        : "Choose a source project to see importable rules."}
                    </p>
                  ) : isLoading ? (
                    <p className="text-[12px] text-stone-500 dark:text-stone-400 py-8 text-center">
                      Loading permissions…
                    </p>
                  ) : isError ? (
                    <p className="text-[12px] text-red-500 dark:text-red-400 py-8 text-center">
                      Failed to load permissions. Please try again.
                    </p>
                  ) : newRules.length === 0 ? (
                    <p className="text-[12px] text-stone-500 dark:text-stone-400 py-8 text-center">
                      All rules from this project are already present.
                    </p>
                  ) : (
                    <PermissionsRulesTable
                      rules={newRules}
                      editable={false}
                      paginate
                      showTypeFilter
                      selection={{ selectedKeys, onToggleKey: toggleKey }}
                      emptyMessage="No rules to import."
                    />
                  )}
                </div>

                {/* Right: merged preview */}
                <div className="px-5 py-4 space-y-3 min-h-[320px]">
                  <div className="flex items-center h-5">
                    <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                      {`Preview${merged.length > 0 ? ` (${merged.length})` : ""}`}
                    </span>
                  </div>
                  <PermissionsRulesTable
                    rules={merged}
                    editable={false}
                    paginate
                    showTypeFilter
                    highlightKeys={addedKeys}
                    emptyMessage="No rules."
                  />
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  onPress={handleClose}
                  className="text-[11px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 px-3 py-1.5 outline-none transition-colors"
                >
                  Cancel
                </Button>
                <Button
                  onPress={handleImport}
                  isDisabled={selectedKeys.size === 0}
                  className="text-[11px] font-medium px-3 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-stone-950 outline-none transition-colors"
                >
                  Import
                  {selectedKeys.size > 0
                    ? ` ${selectedKeys.size} rule${selectedKeys.size !== 1 ? "s" : ""}`
                    : ""}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
