import { Menu, MenuItem, MenuSection, Header, Popover, Separator } from "react-aria-components";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { agentDotClass } from "./settings/agents/agent-color";
import { describeEffectiveParams, NO_PARAMS_LABEL } from "./settings/agents/agent-params";

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

/** The right-aligned summary line: what this entry will actually launch with. */
function presetSummary(preset: ResolvedAgentPreset): string {
  const params = describeEffectiveParams(preset.params);
  if (params !== NO_PARAMS_LABEL) return params;
  return preset.resolvedAgentName ? `→ ${preset.resolvedAgentName}` : "";
}

function PresetItem({ preset }: { preset: ResolvedAgentPreset }) {
  const blocked = preset.unresolved;
  return (
    <MenuItem
      id={`${PRESET_KEY_PREFIX}${preset.id}`}
      textValue={preset.name}
      // The label carries the summary, or the blocker when there is one, so a
      // screen reader hears why an entry is disabled rather than just that it
      // is.
      aria-label={`${preset.name}: ${blocked ? blocked.message : presetSummary(preset)}`}
      isDisabled={blocked !== undefined}
      className={({ isFocused, isDisabled }) => ITEM_CLASS(isFocused, isDisabled)}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${agentDotClass(preset.agentPluginId)}`}
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
          unavailable
        </span>
      ) : (
        <span className="ml-auto text-[10px] font-mono text-stone-400 dark:text-stone-600 truncate">
          {presetSummary(preset)}
        </span>
      )}
    </MenuItem>
  );
}

function AgentItem({ agent }: { agent: ProjectAgentState }) {
  // Two different blockers, one launchability answer: the registry says the
  // plugin cannot connect, the validator says its config does not hold up.
  const blocked = agent.unavailable ?? agent.misconfigured;
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
          {agent.misconfigured && !agent.unavailable ? "configure first" : "unavailable"}
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
  onLaunchPreset,
  onLaunchAgent,
}: {
  presets: ResolvedAgentPreset[];
  agents: ProjectAgentState[];
  onLaunchPreset: (preset: ResolvedAgentPreset) => void;
  onLaunchAgent: (agent: ProjectAgentState) => void;
}) {
  const builtins = presets.filter((preset) => preset.source === "builtin");
  const agentTools = presets.filter((preset) => preset.source !== "builtin");

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
          }
        }}
        className="outline-none"
      >
        <MenuSection>
          <Header className={SECTION_HEADER_CLASS}>Built-in &middot; default agent</Header>
          {builtins.map((preset) => (
            <PresetItem key={preset.id} preset={preset} />
          ))}
        </MenuSection>

        <MenuSection>
          <Header className={SECTION_HEADER_CLASS}>Agent tools</Header>
          {agentTools.map((preset) => (
            <PresetItem key={preset.id} preset={preset} />
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
         * groups. The dialog behind it is issue #518, so the entry ships
         * visible but inert rather than the groups shipping without it.
         */}
        <MenuItem
          id={OVERRIDES_ACTION_ID}
          textValue="Launch with overrides"
          aria-label="Launch with overrides"
          isDisabled
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
