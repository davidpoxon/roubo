import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  Button,
  TooltipTrigger,
  Tooltip,
  MenuTrigger,
  Menu,
  MenuItem,
  Popover,
} from "react-aria-components";
import { Plus, Bot, X, ChevronDown } from "lucide-react";
import { useTerminalSessions, useCreateTerminal, useDestroyTerminal } from "../hooks/useTerminal";
import { useJigs, useInjectJig } from "../hooks/useJigs";
import { useSettings } from "../hooks/useSettings";
import { useDismissNotification } from "../hooks/useBenches";
import { useAgentPresets } from "../hooks/useAgentTools";
import { useProjectAgents } from "../hooks/useProjectAgents";
import { useProjectDefaultJig } from "../hooks/useProjectDefaultJig";
import Terminal from "./Terminal";
import NotificationIndicator from "./NotificationIndicator";
import AgentLaunchMenu from "./AgentLaunchMenu";
import AgentLaunchFailurePanel from "./AgentLaunchFailurePanel";
import LaunchOverridesDialog, { type LaunchOverridesSelection } from "./LaunchOverridesDialog";
import { agentLaunchBlocker, resolveLaunchTarget } from "./settings/agents/agent-launchability";
import { agentTextClass } from "./settings/agents/agent-color";
import {
  AGENT_TOOL_JIG_INHERIT,
  AGENT_TOOL_JIG_NONE,
  BUILTIN_DEFAULT_AGENT_PRESET_ID,
  GLOBAL_DEFAULT_JIG_ID,
} from "@roubo/shared";
import type {
  AgentLaunchFailure,
  JigMeta,
  BenchNotification,
  ProjectAgentState,
  ResolvedAgentPreset,
  TerminalSession,
} from "@roubo/shared";
import { ApiError } from "../lib/api";
import { useBenchViewState } from "../hooks/useBenchViewState";
import { useToast } from "../hooks/useToast";

/**
 * The agent a session tab belongs to. `agentPluginId` is the only carrier:
 * since #521 every agent session is opened by an agent plugin, and a session
 * without one is a plain shell terminal.
 */
function sessionAgentId(session: TerminalSession): string | undefined {
  return session.agentPluginId;
}

function SourceBadge({ source }: { source: JigMeta["source"] }) {
  if (source === "app") return null;
  return (
    <span className="ml-auto text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0 bg-violet-500/15 text-violet-400">
      {source}
    </span>
  );
}

/**
 * The jig picker for a live session (inject into the running agent). The launch
 * path no longer routes through this menu: since #517 a launch resolves its jig
 * from auto-inject and the chosen preset, and the split-button's chevron opens
 * `AgentLaunchMenu` instead.
 */
function JigMenu({ jigs, onSelect }: { jigs: JigMeta[]; onSelect: (id: string) => void }) {
  return (
    <Popover
      placement="bottom end"
      offset={6}
      className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl p-1 min-w-[14rem] max-w-[18rem] max-h-72 overflow-y-auto"
    >
      <Menu onAction={(key) => onSelect(String(key))} className="outline-none">
        {jigs.map((jig) => (
          <MenuItem
            key={jig.id}
            id={jig.id}
            className={({ isFocused }) =>
              `flex flex-col gap-0.5 px-3 py-2 rounded-lg cursor-default outline-none transition-colors ${
                isFocused ? "bg-stone-100 dark:bg-stone-800" : ""
              }`
            }
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-stone-700 dark:text-stone-300 truncate">
                {jig.name}
              </span>
              <SourceBadge source={jig.source} />
            </div>
            {jig.description && (
              <span className="text-[11px] text-stone-400 dark:text-stone-600 truncate leading-relaxed">
                {jig.description}
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
  const injectJig = useInjectJig();
  const { data: jigs } = useJigs(projectId);
  const { settings } = useSettings();
  const { addToast } = useToast();
  const { data: presetsResponse } = useAgentPresets(projectId);
  const { data: projectAgents } = useProjectAgents(projectId);
  // The project's effective default jig, so a launch carrying the
  // `GLOBAL_DEFAULT_JIG_ID` sentinel can still read that jig's agent binding.
  const { data: defaultJig } = useProjectDefaultJig(projectId);

  const availableJigs = useMemo(() => jigs ?? [], [jigs]);
  const presets = useMemo(() => presetsResponse?.presets ?? [], [presetsResponse]);
  const agents = useMemo(() => projectAgents?.agents ?? [], [projectAgents]);

  const { activeTerminalSessionId, setActiveTerminalSessionId } = useBenchViewState(
    projectId,
    benchId,
  );

  const [userSelectedTab, setUserSelectedTab] = useState<string | null>(
    () => activeTerminalSessionId ?? null,
  );
  const [justCreated, setJustCreated] = useState<string | null>(null);
  // A launch refused BEFORE any session existed (below-floor CLI, missing
  // binary): there is no terminal to render the error inside, so the panel takes
  // the terminal pane itself. Without this the only surface would be a toast,
  // which is exactly the silent-failure shape AP-NFR-003 rules out.
  const [blockedLaunch, setBlockedLaunch] = useState<AgentLaunchFailure | null>(null);
  // The per-launch override dialog (issue #518). The counter is the remount key:
  // each open mounts a fresh form, so a cancelled draft is unrecoverable rather
  // than merely hidden, which is what makes "nothing is persisted" structural
  // rather than a cleanup step that can be forgotten (AP-TC-034).
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [overridesKey, setOverridesKey] = useState(0);
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

  /** The structured failure a refused launch carries, when it carries one. */
  const readLaunchFailure = (err: unknown): AgentLaunchFailure | null => {
    if (!(err instanceof ApiError) || !err.details || typeof err.details !== "object") return null;
    const failure = (err.details as { launchFailure?: AgentLaunchFailure }).launchFailure;
    return failure && typeof failure.message === "string" ? failure : null;
  };

  // The most recent launch attempt, so the failure panel's Retry re-runs the same
  // launch rather than a generic one (AP-TC-075). Discriminated because the two
  // launch paths are genuinely different calls: a bare command goes through
  // `handleCreate`, an agent through `launchAgent`.
  const lastLaunchRef = useRef<
    | { kind: "command"; command?: string; jigId?: string }
    | {
        kind: "agent";
        agentPluginId: string;
        agentName: string;
        jigId?: string;
        presetOverrides?: Record<string, unknown>;
        perLaunchOverrides?: Record<string, unknown>;
      }
    | null
  >(null);

  const handleCreate = useCallback(
    (command?: string, jigId?: string) => {
      lastLaunchRef.current = { kind: "command", command, jigId };
      createTerminal.mutate(
        { projectId, benchId, command, jigId },
        {
          onSuccess: (response) => {
            setBlockedLaunch(null);
            setJustCreated(response.sessionId);
            setUserSelectedTab(response.sessionId);
          },
          onError: (err) => {
            const failure = readLaunchFailure(err);
            if (failure) {
              setBlockedLaunch(failure);
              return;
            }
            const message = err instanceof Error ? err.message : "Terminal could not be started";
            addToast(message);
          },
        },
      );
    },
    [projectId, benchId, createTerminal, addToast],
  );

  /**
   * Which jig an agent launch carries. Auto-inject decides the baseline, and a
   * preset's own `jig` field
   * then overrides it: the two `__inherit__` / `__none__` sentinels mean "keep
   * the baseline" and "explicitly none", and anything else names a jig.
   */
  const resolveLaunchJigId = useCallback(
    (presetJig?: string) => {
      const autoInject = settings?.jigs?.autoInject ?? true;
      const baseline =
        autoInject && hasAssignedIssue
          ? (settings?.jigs?.defaultJigId ?? GLOBAL_DEFAULT_JIG_ID)
          : undefined;
      if (presetJig === undefined || presetJig === AGENT_TOOL_JIG_INHERIT) return baseline;
      if (presetJig === AGENT_TOOL_JIG_NONE) return undefined;
      return presetJig;
    },
    [settings, hasAssignedIssue],
  );

  const launchAgent = useCallback(
    ({
      agentPluginId,
      agentName,
      jigId,
      presetOverrides,
      perLaunchOverrides,
    }: {
      agentPluginId: string;
      agentName: string;
      jigId?: string;
      presetOverrides?: Record<string, unknown>;
      perLaunchOverrides?: Record<string, unknown>;
    }) => {
      lastLaunchRef.current = {
        kind: "agent",
        agentPluginId,
        agentName,
        jigId,
        ...(presetOverrides !== undefined && { presetOverrides }),
        ...(perLaunchOverrides !== undefined && { perLaunchOverrides }),
      };
      createTerminal.mutate(
        {
          projectId,
          benchId,
          jigId,
          agentPluginId,
          ...(presetOverrides !== undefined && { presetOverrides }),
          ...(perLaunchOverrides !== undefined && { perLaunchOverrides }),
        },
        {
          onSuccess: (response) => {
            setBlockedLaunch(null);
            setJustCreated(response.sessionId);
            setUserSelectedTab(response.sessionId);
            // AP-TC-017 S001-O03: the toast names the agent that actually
            // resolved, not the button that was pressed, so a default-bound
            // launch says which agent the default currently is.
            //
            // AP-TC-028 S003-O02 asks it to say the launch carried one-off
            // overrides as well, because that is the one thing about the
            // session a user cannot read back anywhere: the draft is transient
            // by design and no screen keeps it. The suffix is conditioned on a
            // NON-EMPTY draft rather than on the dialog having been used, since
            // a dialog launch that overrode nothing resolves exactly as the
            // plain one did and should not claim otherwise.
            const hasPerLaunch =
              perLaunchOverrides !== undefined && Object.keys(perLaunchOverrides).length > 0;
            addToast(
              hasPerLaunch
                ? `${agentName} session started with overrides`
                : `${agentName} session started`,
            );
          },
          onError: (err) => {
            // A refused agent launch is where the structured failure classes
            // arrive (below-floor CLI, missing binary), and this is the path the
            // agent buttons take, so the panel has to be raised from here too
            // (AP-TC-058, AP-TC-071). Anything unstructured stays a toast.
            const failure = readLaunchFailure(err);
            if (failure) {
              setBlockedLaunch(failure);
              return;
            }
            const message =
              err instanceof Error ? err.message : "Agent session could not be started";
            addToast(message);
          },
        },
      );
    },
    [projectId, benchId, createTerminal, addToast],
  );

  /**
   * The jig a launch will actually run, for the purpose of reading its agent
   * binding. `resolveLaunchJigId` may yield the `GLOBAL_DEFAULT_JIG_ID`
   * sentinel, which only the host expands, so the project's resolved default
   * stands in for it here.
   */
  const jigForLaunch = useCallback(
    (jigId: string | undefined): JigMeta | undefined => {
      if (!jigId) return undefined;
      const id = jigId === GLOBAL_DEFAULT_JIG_ID ? defaultJig?.jigId : jigId;
      return id === undefined ? undefined : availableJigs.find((jig) => jig.id === id);
    },
    [availableJigs, defaultJig],
  );

  /**
   * What a preset would launch under a GIVEN jig. A jig's own agent binding
   * beats the default agent, so the answer only holds against the jig the
   * launch really carries, and that jig is the one thing the launch surfaces
   * disagree about (see the two resolvers below).
   */
  const targetForJig = useCallback(
    (preset: ResolvedAgentPreset, jigId: string | undefined) => {
      const boundId = jigForLaunch(jigId)?.agentPluginId;
      return resolveLaunchTarget(
        preset,
        agents,
        boundId ? agents.find((agent) => agent.id === boundId) : undefined,
      );
    },
    [agents, jigForLaunch],
  );

  /**
   * What a preset would actually launch, resolved through the jig it would
   * carry (AP-FR-006, AP-TC-038). One function behind the menu row, the
   * split-button and the launch handler, so all three always agree about the
   * agent, the summary and the disabled state.
   */
  const targetFor = useCallback(
    (preset: ResolvedAgentPreset) => targetForJig(preset, resolveLaunchJigId(preset.jig)),
    [targetForJig, resolveLaunchJigId],
  );

  /**
   * The same question for the overrides dialog, whose launch carries the
   * bench's own jig baseline rather than the selected preset's jig (issue
   * #676). Reusing `targetFor` there would point the dialog's Agent select at
   * an agent bound by a jig the session never runs under.
   */
  const overridesTargetFor = useCallback(
    (preset: ResolvedAgentPreset) => targetForJig(preset, resolveLaunchJigId()),
    [targetForJig, resolveLaunchJigId],
  );

  const handleLaunchPreset = useCallback(
    (preset: ResolvedAgentPreset) => {
      const jigId = resolveLaunchJigId(preset.jig);
      const target = targetFor(preset);
      // An unresolved preset, or one bound to an agent that cannot launch, never
      // starts a session (AP-TC-032, AP-TC-033, AP-TC-038). The menu already
      // disables it; this is the guard for the primary segment, whose preset can
      // go unresolved between renders.
      if (target.blocked || !target.agentPluginId) {
        addToast(target.blocked?.message ?? `${preset.name} cannot launch right now.`);
        return;
      }
      launchAgent({
        agentPluginId: target.agentPluginId,
        agentName: target.agentName,
        jigId,
        ...(Object.keys(preset.params).length > 0 && { presetOverrides: preset.params }),
      });
    },
    [launchAgent, resolveLaunchJigId, targetFor, addToast],
  );

  const handleLaunchAgentPlugin = useCallback(
    (agent: ProjectAgentState) => {
      const blocked = agentLaunchBlocker(agent);
      if (blocked) {
        addToast(blocked.message);
        return;
      }
      launchAgent({
        agentPluginId: agent.id,
        agentName: agent.name,
        jigId: resolveLaunchJigId(),
      });
    },
    [launchAgent, resolveLaunchJigId, addToast],
  );

  const handleOpenOverrides = useCallback(() => {
    setOverridesKey((key) => key + 1);
    setOverridesOpen(true);
  }, []);

  /**
   * Launch the dialog's draft as the transient top layer (AP-FR-010, AP-FR-011).
   * The draft is sent with the request and nowhere else, so neither a cancelled
   * nor a launched one-off value reaches app or project configuration
   * (AP-TC-034).
   */
  const handleLaunchWithOverrides = useCallback(
    (selection: LaunchOverridesSelection) => {
      setOverridesOpen(false);
      launchAgent({
        agentPluginId: selection.agentPluginId,
        agentName: selection.agentName,
        // An ad-hoc launch carries the bench's own jig baseline. The dialog's
        // preset selection contributes params only (issue #668): adopting the
        // selected preset's own jig would change how the layers combine, not
        // which preset feeds layer three, so it is deliberately left alone.
        // The dialog resolves its own targets through this same baseline
        // (`overridesTargetFor`), so its Agent select names the agent this
        // launch really starts (issue #676).
        jigId: resolveLaunchJigId(),
        ...(selection.presetOverrides !== undefined && {
          presetOverrides: selection.presetOverrides,
        }),
        ...(Object.keys(selection.perLaunchOverrides).length > 0 && {
          perLaunchOverrides: selection.perLaunchOverrides,
        }),
      });
    },
    [launchAgent, resolveLaunchJigId],
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

  /** Re-run the launch that failed, down the same path it took the first time. */
  const handleRetryLastLaunch = useCallback(() => {
    const last = lastLaunchRef.current;
    if (!last) return;
    if (last.kind === "agent") {
      launchAgent(last);
      return;
    }
    handleCreate(last.command, last.jigId);
  }, [handleCreate, launchAgent]);

  /**
   * Retry a session that spawned and then died: the dead tab goes away and the
   * same launch re-runs, so Retry never leaves the failed session behind. An
   * agent session relaunches through the agent pipeline, since that is the only
   * path that re-runs the version gate and the descriptor resolution.
   */
  const handleRetrySession = useCallback(
    (session: { id: string; command?: string; agentPluginId?: string }) => {
      handleDestroy(session.id);
      if (session.agentPluginId) {
        const agent = agents.find((candidate) => candidate.id === session.agentPluginId);
        launchAgent({
          agentPluginId: session.agentPluginId,
          agentName: agent?.name ?? session.agentPluginId,
        });
        return;
      }
      handleCreate(session.command);
    },
    [agents, handleDestroy, handleCreate, launchAgent],
  );

  const handleInjectJig = useCallback(
    (jigId: string) => {
      injectJig.mutate({
        projectId,
        benchId,
        jigId: jigId,
        sessionId: activeTab ?? undefined,
      });
    },
    [projectId, benchId, injectJig, activeTab],
  );

  // Extract the short label: "Terminal 1", or "<Agent name> 1" for an agent
  // session, whose label the server builds from the plugin's own manifest name.
  // The server's label format is `<name> <index> - <project> #<bench>`, so the
  // leading segment is the whole answer and no name needs to be known here.
  const shortLabel = (label: string) => label.split(" - ")[0];

  void projectName; // Used by server to generate labels

  // The primary segment fires the built-in default-agent preset rather than
  // resolving the default itself: the server already resolves that preset to an
  // agent plugin id and a display name, so there is one resolution path, not
  // two that can disagree (AP-TC-017). The target is resolved through the same
  // path the press takes, so the label, the tooltip and the disabled state all
  // describe the agent that would actually start.
  const defaultPreset = presets.find((preset) => preset.id === BUILTIN_DEFAULT_AGENT_PRESET_ID);
  const primaryTarget = defaultPreset ? targetFor(defaultPreset) : undefined;
  const primaryLabel = primaryTarget?.agentName ?? "Agent";
  const primaryDisabled = primaryTarget === undefined || primaryTarget.blocked !== null;
  const primaryTooltip = primaryTarget?.blocked
    ? primaryTarget.blocked.message
    : `Launch ${primaryLabel}`;

  const launchMenu = (
    <AgentLaunchMenu
      presets={presets}
      agents={agents}
      resolveTarget={targetFor}
      onLaunchPreset={handleLaunchPreset}
      onLaunchAgent={handleLaunchAgentPlugin}
      onLaunchWithOverrides={handleOpenOverrides}
    />
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Per-launch overrides (issue #518). Keyed so each open is a fresh form. */}
      {overridesOpen && (
        <LaunchOverridesDialog
          key={overridesKey}
          isOpen
          agents={agents}
          presets={presets}
          resolveTarget={overridesTargetFor}
          initialPresetId={defaultPreset?.id ?? null}
          onCancel={() => setOverridesOpen(false)}
          onLaunch={handleLaunchWithOverrides}
        />
      )}

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
              {sessionAgentId(session) !== undefined && (
                <Bot
                  size={11}
                  data-testid="session-agent-icon"
                  className={`shrink-0 ${agentTextClass(sessionAgentId(session))}`}
                />
              )}
              <span className="whitespace-nowrap">{shortLabel(session.label)}</span>
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
          {/* Jig picker: only shown when there are active sessions */}
          {currentSessions.length > 0 && availableJigs.length > 0 && (
            <MenuTrigger>
              <TooltipTrigger delay={500}>
                <Button
                  aria-label="Inject jig"
                  className="flex items-center gap-1 px-2 py-1.5 rounded-md text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none"
                >
                  <Bot size={13} className="text-stone-400" />
                  <ChevronDown size={10} className="text-stone-400" />
                </Button>
                <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                  Inject jig
                </Tooltip>
              </TooltipTrigger>
              <JigMenu jigs={availableJigs} onSelect={handleInjectJig} />
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

          {/* Agent split-button: primary segment launches the default agent,
              chevron opens the grouped launch menu (AP-FR-007, issue #517). */}
          <div className="flex items-center">
            <TooltipTrigger delay={500}>
              <Button
                aria-label={`Launch ${primaryLabel}`}
                isDisabled={primaryDisabled}
                onPress={() => defaultPreset && handleLaunchPreset(defaultPreset)}
                className="p-1.5 rounded-l-md text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-800 disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <Bot size={14} />
              </Button>
              <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                {primaryTooltip}
              </Tooltip>
            </TooltipTrigger>
            <MenuTrigger>
              <Button
                aria-label="Choose launch option"
                className="flex items-center px-1 py-1.5 text-stone-400 dark:text-stone-600 rounded-r-md border-l border-stone-200 dark:border-stone-700/30 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <ChevronDown size={10} />
              </Button>
              {launchMenu}
            </MenuTrigger>
          </div>
        </div>
      </div>

      {/* Terminal content */}
      <div className="relative flex-1 bg-[#09090b] rounded-b-lg overflow-hidden">
        {blockedLaunch && (
          <AgentLaunchFailurePanel failure={blockedLaunch} onRetry={handleRetryLastLaunch} />
        )}
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
              {/* The same split-button as the tab bar, in the empty state. */}
              <div className="flex items-center">
                <Button
                  isDisabled={primaryDisabled}
                  onPress={() => defaultPreset && handleLaunchPreset(defaultPreset)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 rounded-l-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
                >
                  <Bot size={12} />
                  {primaryLabel}
                </Button>
                <MenuTrigger>
                  <Button
                    aria-label="Choose launch option"
                    className="flex items-center px-1.5 py-1.5 text-stone-950/70 bg-amber-500 hover:bg-amber-400 rounded-r-lg border-l border-stone-950/20 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
                  >
                    <ChevronDown size={10} />
                  </Button>
                  {launchMenu}
                </MenuTrigger>
              </div>
            </div>
          </div>
        ) : (
          currentSessions.map((session) => (
            <div key={session.id} className={`h-full ${activeTab === session.id ? "" : "hidden"}`}>
              <Terminal
                sessionId={session.id}
                active={activeTab === session.id}
                onRetry={() => handleRetrySession(session)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
