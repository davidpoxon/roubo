import { Menu, MenuItem, MenuSection, Header, Popover, Separator } from "react-aria-components";
import { AlertTriangle, Info, SlidersHorizontal } from "lucide-react";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { agentDotClass } from "./settings/agents/agent-color";
import { describeEffectiveParams, NO_PARAMS_LABEL } from "./settings/agents/agent-params";
import { agentLaunchBlocker, type LaunchTarget } from "./settings/agents/agent-launchability";

// The bench Terminal tab's grouped launch menu (AP-FR-007, AP-FR-009, issue
// #517).
//
// Three sections in a fixed order (AP-TC-043): the presets Roubo ships, the
// named agent tools an app or a project declares, and one entry per installed
// agent. The order is structural, not a ranking: a reader scans the same three
// headers in every bench, so the menu never re-orders itself under them.
//
// Nothing that cannot launch is launchable. An unresolved preset and an agent
// that is unavailable or unconfigured both render as a disabled row carrying
// the reason (AP-TC-038), rather than vanishing, so the fix is discoverable
// instead of the entry silently going missing.

export const OVERRIDES_ACTION_ID = "__launch_with_overrides__";

const PRESET_KEY_PREFIX = "preset:";
const AGENT_KEY_PREFIX = "agent:";

const SECTION_HEADER_CLASS =
  "px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.15em] text-stone-400 dark:text-stone-600 font-semibold";

const ITEM_CLASS = (isFocused: boolean, isDisabled: boolean) =>
  [
    "flex items-center gap-2 px-3 py-2 rounded-lg cursor-default outline-none transition-colors",
    isDisabled ? "opacity-50 cursor-not-allowed" : "",
    isFocused && !isDisabled ? "bg-stone-100 dark:bg-stone-800" : "",
  ]
    .filter(Boolean)
    .join(" ");

/**
 * The right-aligned summary line: what this entry will actually launch with.
 * The agent named is the RESOLVED target, not the preset's own binding, so a
 * row redirected by a jig binding says which agent it will really start.
 *
 * Both halves, params then the resolved agent (`plan → Claude Code`), because
 * either alone is half an answer: a row that names only its params leaves the
 * agent it will start unsaid, which is what AP-TC-027 S001-O01 reads (issue
 * #691). A preset overriding nothing is just the arrow, and one whose target
 * did not resolve is just the params.
 */
function presetSummary(preset: ResolvedAgentPreset, target: LaunchTarget): string {
  const params = describeEffectiveParams(preset.params);
  const resolved = target.agentPluginId ? `→ ${target.agentName}` : "";
  if (params === NO_PARAMS_LABEL) return resolved;
  return resolved === "" ? params : `${params} ${resolved}`;
}

function PresetItem({ preset, target }: { preset: ResolvedAgentPreset; target: LaunchTarget }) {
  // The row reads the same resolved target the split-button does, so a preset
  // can never render disabled here while the button beside it launches it.
  const blocked = target.blocked;
  // Advisory, never a blocker (issue #665): a built-in that dropped a rejected
  // param still launches, it just will not do what its name promises. The
  // notice therefore rides in the summary slot and leaves `isDisabled` alone,
  // where the amber blocker chip disables the row.
  const degraded = blocked === null ? preset.degraded : undefined;
  const summary = blocked
    ? blocked.message
    : `${presetSummary(preset, target)}${degraded ? `. ${degraded.message}` : ""}`;
  return (
    <MenuItem
      id={`${PRESET_KEY_PREFIX}${preset.id}`}
      textValue={preset.name}
      // The label carries the summary, or the blocker when there is one, so a
      // screen reader hears why an entry is disabled rather than just that it
      // is.
      aria-label={`${preset.name}: ${summary}`}
      isDisabled={blocked !== null}
      // Identifying rather than generic, so a browser-driven check can name the
      // preset row it means (AP-TC-026 S001, AP-TC-027 S001) instead of indexing
      // into an ordered list.
      data-testid={`launch-preset-${preset.id}`}
      className={({ isFocused, isDisabled }) => ITEM_CLASS(isFocused, isDisabled)}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${agentDotClass(target.agentPluginId)}`}
      />
      <span className="text-xs font-medium text-stone-700 dark:text-stone-300 truncate">
        {preset.name}
      </span>
      {blocked ? (
        <span
          title={blocked.message}
          className="ml-auto flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500 shrink-0"
        >
          <AlertTriangle size={10} />
          {blocked.label}
        </span>
      ) : degraded ? (
        <span
          title={degraded.message}
          data-testid="preset-degraded-notice"
          className="ml-auto flex items-center gap-1 text-[10px] text-stone-500 dark:text-stone-400 shrink-0"
        >
          <Info size={10} />
          drops {degraded.droppedParams.join(", ")}
        </span>
      ) : (
        <span
          data-testid="launch-preset-summary"
          className="ml-auto text-[10px] font-mono text-stone-400 dark:text-stone-600 truncate"
        >
          {presetSummary(preset, target)}
        </span>
      )}
    </MenuItem>
  );
}

function AgentItem({ agent }: { agent: ProjectAgentState }) {
  const blocked = agentLaunchBlocker(agent);
  return (
    <MenuItem
      id={`${AGENT_KEY_PREFIX}${agent.id}`}
      textValue={agent.name}
      aria-label={`${agent.name}: ${blocked ? blocked.message : describeEffectiveParams(agent.effective)}`}
      isDisabled={blocked !== null}
      data-testid="launch-agent-item"
      className={({ isFocused, isDisabled }) => ITEM_CLASS(isFocused, isDisabled)}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${agentDotClass(agent.id)}`} />
      <span className="text-xs font-medium text-stone-700 dark:text-stone-300 truncate">
        {agent.name}
      </span>
      {blocked ? (
        <span
          title={blocked.message}
          className="ml-auto flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500 shrink-0"
        >
          <AlertTriangle size={10} />
          {blocked.label}
        </span>
      ) : (
        <span className="ml-auto text-[10px] font-mono text-stone-400 dark:text-stone-600 truncate">
          {describeEffectiveParams(agent.effective)}
        </span>
      )}
    </MenuItem>
  );
}

export default function AgentLaunchMenu({
  presets,
  agents,
  resolveTarget,
  onLaunchPreset,
  onLaunchAgent,
  onLaunchWithOverrides,
}: {
  presets: ResolvedAgentPreset[];
  agents: ProjectAgentState[];
  /**
   * What a preset would actually launch. Supplied by the owner rather than
   * recomputed here, because it depends on the jig the launch would carry,
   * which only the Terminal tab resolves.
   */
  resolveTarget: (preset: ResolvedAgentPreset) => LaunchTarget;
  onLaunchPreset: (preset: ResolvedAgentPreset) => void;
  onLaunchAgent: (agent: ProjectAgentState) => void;
  /** Open the per-launch override dialog (AP-FR-010, issue #518). */
  onLaunchWithOverrides: () => void;
}) {
  const builtins = presets.filter((preset) => preset.source === "builtin");
  const agentTools = presets.filter((preset) => preset.source !== "builtin");
  // The dialog can only offer agents that can actually launch, so with none of
  // them launchable the action would open onto an empty picker. Disabling it
  // keeps the rule that nothing which cannot launch is launchable (AP-TC-038).
  const hasLaunchableAgent = agents.some((agent) => agentLaunchBlocker(agent) === null);

  return (
    <Popover
      placement="bottom end"
      offset={6}
      className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl p-1 min-w-[16rem] max-w-[20rem] max-h-80 overflow-y-auto"
    >
      <Menu
        onAction={(key) => {
          const k = String(key);
          if (k.startsWith(PRESET_KEY_PREFIX)) {
            const preset = presets.find((p) => p.id === k.slice(PRESET_KEY_PREFIX.length));
            if (preset) onLaunchPreset(preset);
            return;
          }
          if (k.startsWith(AGENT_KEY_PREFIX)) {
            const agent = agents.find((a) => a.id === k.slice(AGENT_KEY_PREFIX.length));
            if (agent) onLaunchAgent(agent);
            return;
          }
          if (k === OVERRIDES_ACTION_ID) onLaunchWithOverrides();
        }}
        className="outline-none"
      >
        <MenuSection>
          <Header className={SECTION_HEADER_CLASS}>Built-in &middot; default agent</Header>
          {builtins.map((preset) => (
            <PresetItem key={preset.id} preset={preset} target={resolveTarget(preset)} />
          ))}
        </MenuSection>

        <MenuSection>
          <Header className={SECTION_HEADER_CLASS}>Agent tools</Header>
          {agentTools.map((preset) => (
            <PresetItem key={preset.id} preset={preset} target={resolveTarget(preset)} />
          ))}
        </MenuSection>

        <MenuSection>
          <Header className={SECTION_HEADER_CLASS}>All agents</Header>
          {agents.map((agent) => (
            <AgentItem key={agent.id} agent={agent} />
          ))}
        </MenuSection>

        <Separator className="my-1 border-t border-stone-200 dark:border-stone-800" />

        {/*
         * Structurally required by AP-TC-043 O02: the action sits below the
         * groups, separated from them, because it adjusts a launch rather than
         * naming one. It opens the per-launch override dialog (issue #518).
         */}
        <MenuItem
          id={OVERRIDES_ACTION_ID}
          textValue="Launch with overrides"
          aria-label="Launch with overrides"
          isDisabled={!hasLaunchableAgent}
          className={({ isFocused, isDisabled }) => ITEM_CLASS(isFocused, isDisabled)}
        >
          <SlidersHorizontal size={12} className="text-stone-400 dark:text-stone-600 shrink-0" />
          <span className="text-xs font-medium text-stone-700 dark:text-stone-300">
            Launch with overrides&hellip;
          </span>
        </MenuItem>
      </Menu>
    </Popover>
  );
}
