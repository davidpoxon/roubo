import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  Button,
  TooltipTrigger,
  Tooltip,
  MenuTrigger,
  Menu,
  MenuItem,
  Popover,
  Separator,
} from "react-aria-components";
import { Plus, Bot, X, ChevronDown } from "lucide-react";
import { useTerminalSessions, useCreateTerminal, useDestroyTerminal } from "../hooks/useTerminal";
import { useBlueprints, useInjectBlueprint } from "../hooks/useBlueprints";
import { useSettings } from "../hooks/useSettings";
import { useDismissNotification } from "../hooks/useBenches";
import Terminal from "./Terminal";
import NotificationIndicator from "./NotificationIndicator";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import type { BlueprintMeta, BenchNotification, ClaudeCodeMode } from "@roubo/shared";
import { useBenchViewState } from "../hooks/useBenchViewState";
import { useToast } from "../hooks/useToast";

const modeLabelMap: Record<ClaudeCodeMode, string> = {
  auto: "auto",
  plan: "plan",
  "plan-auto": "plan \u2192 auto",
};

function ModeBadge({ mode }: { mode?: ClaudeCodeMode }) {
  if (!mode) return null;
  return (
    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0 bg-amber-500/15 text-amber-400">
      {modeLabelMap[mode]}
    </span>
  );
}

function SourceBadge({ source }: { source: BlueprintMeta["source"] }) {
  if (source === "app") return null;
  return (
    <span className="ml-auto text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0 bg-violet-500/15 text-violet-400">
      {source}
    </span>
  );
}

const LAUNCH_FRESH_ID = "__launch_fresh";

function BlueprintMenu({
  blueprints,
  onSelect,
  onLaunchFresh,
}: {
  blueprints: BlueprintMeta[];
  onSelect: (id: string) => void;
  onLaunchFresh?: () => void;
}) {
  return (
    <Popover
      placement="bottom end"
      offset={6}
      className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl p-1 min-w-[14rem] max-w-[18rem] max-h-72 overflow-y-auto"
    >
      <Menu
        onAction={(key) => {
          const k = String(key);
          if (k === LAUNCH_FRESH_ID) onLaunchFresh?.();
          else onSelect(k);
        }}
        className="outline-none"
      >
        {onLaunchFresh && (
          <MenuItem
            id={LAUNCH_FRESH_ID}
            className={({ isFocused }) =>
              `flex items-center gap-2 px-3 py-2 rounded-lg cursor-default outline-none transition-colors ${
                isFocused ? "bg-stone-100 dark:bg-stone-800" : ""
              }`
            }
          >
            <Bot size={11} className="text-stone-400 dark:text-stone-600" />
            <span className="text-xs font-medium text-stone-700 dark:text-stone-300">
              Launch without blueprint
            </span>
          </MenuItem>
        )}
        {onLaunchFresh && blueprints.length > 0 && (
          <Separator className="my-1 border-t border-stone-200 dark:border-stone-800" />
        )}
        {blueprints.map((blueprint) => (
          <MenuItem
            key={blueprint.id}
            id={blueprint.id}
            className={({ isFocused }) =>
              `flex flex-col gap-0.5 px-3 py-2 rounded-lg cursor-default outline-none transition-colors ${
                isFocused ? "bg-stone-100 dark:bg-stone-800" : ""
              }`
            }
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-stone-700 dark:text-stone-300 truncate">
                {blueprint.name}
              </span>
              <SourceBadge source={blueprint.source} />
            </div>
            {blueprint.description && (
              <span className="text-[11px] text-stone-400 dark:text-stone-600 truncate leading-relaxed">
                {blueprint.description}
              </span>
            )}
          </MenuItem>
        ))}
      </Menu>
    </Popover>
  );
}

export default function TerminalTabs({
  projectId,
  benchId,
  projectName,
  hasAssignedIssue,
  notifications = [],
}: {
  projectId: string;
  benchId: number;
  projectName: string;
  hasAssignedIssue: boolean;
  notifications?: BenchNotification[];
}) {
  const { data: sessions } = useTerminalSessions(projectId, benchId);
  const createTerminal = useCreateTerminal();
  const destroyTerminal = useDestroyTerminal();
  const { mutate: dismissNotification } = useDismissNotification();
  const injectBlueprint = useInjectBlueprint();
  const { data: blueprints } = useBlueprints(projectId);
  const { settings, isLoading: settingsLoading } = useSettings();
  const { addToast } = useToast();

  const { activeTerminalSessionId, setActiveTerminalSessionId } = useBenchViewState(
    projectId,
    benchId,
  );

  const [userSelectedTab, setUserSelectedTab] = useState<string | null>(
    () => activeTerminalSessionId ?? null,
  );
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const currentSessions = useMemo(() => sessions ?? [], [sessions]);

  // Derive activeTab: prefer user selection if valid, fall back to first session
  const activeTab = useMemo(() => {
    if (userSelectedTab && currentSessions.some((s) => s.id === userSelectedTab)) {
      return userSelectedTab;
    }
    if (userSelectedTab && userSelectedTab === justCreated) {
      return userSelectedTab;
    }
    return currentSessions.length > 0 ? currentSessions[0].id : null;
  }, [userSelectedTab, justCreated, currentSessions]);

  // Persist the active terminal session so it can be restored after navigation/reload.
  // Guard on sessions !== undefined to avoid clearing a valid persisted ID while the
  // initial fetch is still in flight (before sessions load, activeTab resolves to null).
  useEffect(() => {
    if (sessions !== undefined) {
      setActiveTerminalSessionId(activeTab);
    }
  }, [activeTab, sessions, setActiveTerminalSessionId]);

  // Dismiss session-scoped notifications for the active tab. A ref tracks
  // already-dismissed IDs so each notification is dismissed exactly once per
  // mount even though `notifications` gets a new array reference on every poll.
  // The set clears when activeTab changes so switching back re-dismisses any
  // new notifications that arrived on the tab in the interim.
  const dismissedNotifIds = useRef(new Set<string>());
  useEffect(() => {
    dismissedNotifIds.current.clear();
  }, [activeTab]);
  useEffect(() => {
    if (!activeTab) return;
    for (const notif of notifications.filter(
      (n: BenchNotification) => n.sourceSessionId === activeTab,
    )) {
      if (!dismissedNotifIds.current.has(notif.id)) {
        dismissedNotifIds.current.add(notif.id);
        dismissNotification({ projectId, benchId, notificationId: notif.id });
      }
    }
  }, [activeTab, projectId, benchId, dismissNotification, notifications]);

  const handleCreate = useCallback(
    (command?: string, blueprintId?: string, skipAutoInject = false) => {
      // For Claude sessions, determine which blueprint to inject (if any) at creation time.
      // The server handles injection via CLI arg for reliable auto-execute.
      let targetBlueprintId: string | undefined;
      if (command === "claude") {
        const autoInject = settings?.blueprints?.autoInject ?? true;
        if (blueprintId) {
          targetBlueprintId = blueprintId;
        } else if (autoInject && hasAssignedIssue && !skipAutoInject) {
          targetBlueprintId =
            settings?.blueprints?.defaultBlueprintId ?? GLOBAL_DEFAULT_BLUEPRINT_ID;
        }
      }

      createTerminal.mutate(
        { projectId, benchId, command, blueprintId: targetBlueprintId },
        {
          onSuccess: (response) => {
            setJustCreated(response.sessionId);
            setUserSelectedTab(response.sessionId);
          },
          onError: (err) => {
            const message = err instanceof Error ? err.message : "Terminal could not be started";
            addToast(message);
          },
        },
      );
    },
    [projectId, benchId, createTerminal, settings, hasAssignedIssue, addToast],
  );

  const handleDestroy = useCallback(
    (sessionId: string) => {
      destroyTerminal.mutate({ projectId, benchId, sessionId });
      if (userSelectedTab === sessionId) {
        const remaining = currentSessions.filter((s) => s.id !== sessionId);
        setUserSelectedTab(remaining.length > 0 ? remaining[0].id : null);
      }
    },
    [projectId, benchId, destroyTerminal, userSelectedTab, currentSessions],
  );

  const handleInjectBlueprint = useCallback(
    (blueprintId: string) => {
      injectBlueprint.mutate({
        projectId,
        benchId,
        blueprintId: blueprintId,
        sessionId: activeTab ?? undefined,
      });
    },
    [projectId, benchId, injectBlueprint, activeTab],
  );

  // Extract short label (e.g., "Terminal 1" or "Claude 1")
  const shortLabel = (label: string) => {
    const match = label.match(/^(Terminal|Claude)\s+\d+/);
    return match ? match[0] : label.split(" - ")[0];
  };

  void projectName; // Used by server to generate labels

  const availableBlueprints = blueprints ?? [];
  const autoInjectEnabled = settings?.blueprints?.autoInject ?? true;
  const wouldAutoInject = !settingsLoading && autoInjectEnabled && hasAssignedIssue;
  const showClaudeDropdown = availableBlueprints.length > 0 || wouldAutoInject;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center border-b border-stone-200 dark:border-stone-800/60 shrink-0">
        <div className="flex items-center gap-0.5 overflow-x-auto px-1 py-1">
          {currentSessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs cursor-default transition-colors ${
                session.status === "ended"
                  ? activeTab === session.id
                    ? "bg-stone-200 dark:bg-stone-800 text-stone-500 dark:text-stone-400"
                    : "text-stone-400 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 hover:bg-stone-200/60 dark:hover:bg-stone-800/50"
                  : activeTab === session.id
                    ? "bg-stone-200 dark:bg-stone-800 text-stone-800 dark:text-stone-200"
                    : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800/50"
              }`}
              onClick={() => {
                setUserSelectedTab(session.id);
              }}
            >
              {session.command === "claude" && (
                <Bot size={11} className="shrink-0 text-violet-400" />
              )}
              <span className="whitespace-nowrap">{shortLabel(session.label)}</span>
              <ModeBadge mode={session.claudeCodeMode} />
              {activeTab !== session.id && (
                <NotificationIndicator
                  notifications={notifications.filter((n) => n.sourceSessionId === session.id)}
                />
              )}
              <Button
                onPress={() => handleDestroy(session.id)}
                className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-stone-300 dark:hover:bg-stone-700 transition-all outline-none"
              >
                <X size={10} />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-0.5 ml-auto px-2 shrink-0">
          {/* Blueprint picker — only shown when there are active sessions */}
          {currentSessions.length > 0 && availableBlueprints.length > 0 && (
            <MenuTrigger>
              <TooltipTrigger delay={500}>
                <Button className="flex items-center gap-1 px-2 py-1.5 rounded-md text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none">
                  <Bot size={13} className="text-violet-400" />
                  <ChevronDown size={10} className="text-stone-400" />
                </Button>
                <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                  Inject blueprint
                </Tooltip>
              </TooltipTrigger>
              <BlueprintMenu blueprints={availableBlueprints} onSelect={handleInjectBlueprint} />
            </MenuTrigger>
          )}

          <TooltipTrigger delay={500}>
            <Button
              onPress={() => handleCreate()}
              className="p-1.5 rounded-md text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none"
            >
              <Plus size={14} />
            </Button>
            <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
              New terminal
            </Tooltip>
          </TooltipTrigger>

          {/* Claude Code button — show as split button when blueprints exist or auto-inject would fire */}
          {showClaudeDropdown ? (
            <div className="flex items-center">
              <TooltipTrigger delay={500}>
                <Button
                  onPress={() => handleCreate("claude")}
                  className="p-1.5 rounded-l-md text-stone-500 hover:text-violet-400 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none"
                >
                  <Bot size={14} />
                </Button>
                <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                  Launch Claude Code
                </Tooltip>
              </TooltipTrigger>
              <MenuTrigger>
                <Button
                  aria-label="Choose launch option"
                  className="flex items-center px-1 py-1.5 text-stone-400 dark:text-stone-600 rounded-r-md border-l border-stone-200 dark:border-stone-700/30 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none"
                >
                  <ChevronDown size={10} />
                </Button>
                <BlueprintMenu
                  blueprints={availableBlueprints}
                  onSelect={(id) => handleCreate("claude", id)}
                  onLaunchFresh={
                    wouldAutoInject ? () => handleCreate("claude", undefined, true) : undefined
                  }
                />
              </MenuTrigger>
            </div>
          ) : (
            <TooltipTrigger delay={500}>
              <Button
                onPress={() => handleCreate("claude")}
                className="p-1.5 rounded-md text-stone-500 hover:text-violet-400 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none"
              >
                <Bot size={14} />
              </Button>
              <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                Launch Claude Code
              </Tooltip>
            </TooltipTrigger>
          )}
        </div>
      </div>

      {/* Terminal content */}
      <div className="flex-1 bg-[#09090b] rounded-b-lg overflow-hidden">
        {currentSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <p className="text-sm text-stone-600">No terminal sessions</p>
            <div className="flex items-center gap-2">
              <Button
                onPress={() => handleCreate()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-400 bg-stone-800 hover:bg-stone-700 hover:text-stone-200 rounded-lg transition-colors outline-none"
              >
                <Plus size={12} />
                New Terminal
              </Button>
              {showClaudeDropdown ? (
                <div className="flex items-center">
                  <Button
                    onPress={() => handleCreate("claude")}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-400 bg-violet-500/10 hover:bg-violet-500/20 rounded-l-lg transition-colors outline-none"
                  >
                    <Bot size={12} />
                    Claude Code
                  </Button>
                  <MenuTrigger>
                    <Button
                      aria-label="Choose launch option"
                      className="flex items-center px-1.5 py-1.5 text-violet-400 bg-violet-500/10 hover:bg-violet-500/20 rounded-r-lg border-l border-violet-500/20 transition-colors outline-none"
                    >
                      <ChevronDown size={10} />
                    </Button>
                    <BlueprintMenu
                      blueprints={availableBlueprints}
                      onSelect={(id) => handleCreate("claude", id)}
                      onLaunchFresh={
                        wouldAutoInject ? () => handleCreate("claude", undefined, true) : undefined
                      }
                    />
                  </MenuTrigger>
                </div>
              ) : (
                <Button
                  onPress={() => handleCreate("claude")}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-400 bg-violet-500/10 hover:bg-violet-500/20 rounded-lg transition-colors outline-none"
                >
                  <Bot size={12} />
                  Claude Code
                </Button>
              )}
            </div>
          </div>
        ) : (
          currentSessions.map((session) => (
            <div key={session.id} className={`h-full ${activeTab === session.id ? "" : "hidden"}`}>
              <Terminal sessionId={session.id} active={activeTab === session.id} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
