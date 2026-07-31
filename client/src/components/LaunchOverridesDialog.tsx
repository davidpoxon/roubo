import { useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { Bot } from "lucide-react";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { stampAriaModal } from "../lib/aria-modal";
import { INPUT } from "./setup/styles";
import { PARAM_FIELDS, INHERIT, enumOptionsFor } from "./settings/agents/agent-params";
import { agentLaunchBlocker, type LaunchTarget } from "./settings/agents/agent-launchability";
import { buildResolutionTrace, type ResolutionLayer } from "./launch-overrides-trace";

// The per-launch override dialog (AP-FR-010, AP-FR-011, issue #518).
//
// One session only. The draft is the transient fourth resolution layer and is
// sent with the launch request, never written to app or project configuration
// (AP-TC-034). Nothing here saves, so there is no save path to get wrong: the
// form is remounted per open (see the `key` at the call site), which is what
// makes a cancelled draft unrecoverable rather than merely hidden.

export interface LaunchOverridesSelection {
  agentPluginId: string;
  agentName: string;
  /** The transient top layer. Only fields the user actually set. */
  perLaunchOverrides: Record<string, unknown>;
  /** The preset layer beneath it, when a preset contributed to this launch. */
  presetOverrides?: Record<string, unknown>;
}

interface Props {
  isOpen: boolean;
  /** The agents a launch may actually start, unfiltered; blocked ones are dropped here. */
  agents: ProjectAgentState[];
  /**
   * Every preset this launch could start from (issue #668). The selected one's
   * params form the third layer, but only while the selected agent is the one
   * that preset resolves to: a preset's params are validated against that
   * agent's schema, so pointing them at another agent would ship keys its schema
   * never saw (AP-TC-033).
   */
  presets: ResolvedAgentPreset[];
  /**
   * What a preset would actually launch. Supplied by the owner rather than
   * recomputed here, exactly as `AgentLaunchMenu` takes it, because it depends on
   * the jig the launch would carry, which only the Terminal tab resolves. Sharing
   * one resolver is what keeps a surface and its own launch from disagreeing
   * about which agent a preset starts, or about whether it may (AP-TC-038).
   *
   * For THIS dialog that jig is the bench's own baseline, not the selected
   * preset's, because an ad-hoc launch never adopts a preset's jig (issue #676).
   * So the resolver passed here is deliberately not the one the launch menu
   * gets, and the two may legitimately name different agents for one preset.
   */
  resolveTarget: (preset: ResolvedAgentPreset) => LaunchTarget;
  /** Which preset is pre-selected on open, when it is selectable at all. */
  initialPresetId?: string | null;
  onCancel: () => void;
  onLaunch: (selection: LaunchOverridesSelection) => void;
}

const LABEL_CLASS = "block text-[11px] font-medium text-stone-500 mb-1.5";

/** The empty select value that spells "layer three contributes nothing". */
const NO_PRESET = "";

/** Names the resolution trace after the caption above it. */
const RESOLUTION_LABEL_ID = "launch-overrides-resolution-label";

/** One trace line: the layer, then its fields, with superseded values dimmed. */
function LayerLine({ layer }: { layer: ResolutionLayer }) {
  const isPerLaunch = layer.id === "perLaunch";
  return (
    <div data-testid={`resolution-layer-${layer.id}`}>
      <span className="text-stone-400 dark:text-stone-600">
        {layer.id === "app" ? "" : "→ "}
        {layer.label}
      </span>{" "}
      {layer.entries.length === 0 ? (
        <span className="text-stone-300 dark:text-stone-700">nothing</span>
      ) : (
        layer.entries.map((entry) => (
          <span
            key={entry.key}
            data-testid={`resolution-${layer.id}-${entry.key}`}
            data-superseded={entry.superseded ? "true" : "false"}
            className={
              entry.superseded
                ? "text-stone-300 dark:text-stone-700 line-through mr-2"
                : isPerLaunch
                  ? "text-amber-600 dark:text-amber-200 font-semibold mr-2"
                  : "text-stone-500 dark:text-stone-400 mr-2"
            }
          >
            {entry.key}={entry.value}
          </span>
        ))
      )}
    </div>
  );
}

/**
 * The dialog itself. Every field starts on "inherit", so an untouched field is
 * absent from the draft and keeps resolving from the layers beneath it
 * (AP-TC-036 S001-O03), and the trace recomputes on every keystroke, which is
 * what makes it live (AP-TC-029 S002, AP-TC-046).
 */
export default function LaunchOverridesDialog({
  isOpen,
  agents,
  presets,
  resolveTarget,
  initialPresetId,
  onCancel,
  onLaunch,
}: Props) {
  // Nothing that cannot launch is offered, exactly as the launch menu gates its
  // rows: the dialog must not be a way around AP-TC-038.
  const launchable = agents.filter((agent) => agentLaunchBlocker(agent) === null);

  /**
   * Every preset with the target it would actually launch. A preset whose target
   * is blocked, or that resolves to an agent this dialog cannot offer, stays in
   * the list as a disabled option carrying its reason, so the fix is
   * discoverable rather than the entry silently going missing (AP-TC-038), which
   * is how the launch menu treats the same case.
   */
  const choices = presets.map((preset) => {
    const target = resolveTarget(preset);
    const selectable =
      target.blocked === null &&
      target.agentPluginId !== undefined &&
      launchable.some((candidate) => candidate.id === target.agentPluginId);
    return { preset, target, selectable };
  });

  const initialChoice = choices.find(
    (choice) => choice.selectable && choice.preset.id === initialPresetId,
  );

  const [presetId, setPresetId] = useState(initialChoice?.preset.id ?? NO_PRESET);
  const [agentId, setAgentId] = useState(
    initialChoice?.target.agentPluginId ?? launchable[0]?.id ?? "",
  );
  const [params, setParams] = useState<Record<string, string>>({});

  const agent = launchable.find((candidate) => candidate.id === agentId);
  const selectedChoice = choices.find(
    (choice) => choice.selectable && choice.preset.id === presetId,
  );

  /**
   * Re-base the draft on an agent's schema. A value the newly selected agent
   * does not declare (a Claude Code `model=haiku` against a Codex `model` enum)
   * is dropped rather than carried over, so the rendered field and the launched
   * payload can never disagree, and the fields update to reflect the newly
   * selected agent's parameters (AP-TC-029 S001-O01). A field the new agent
   * leaves free text keeps its value: nothing there is invalid.
   */
  const rebaseParams = (nextAgentId: string) => {
    const nextAgent = launchable.find((candidate) => candidate.id === nextAgentId);
    setParams((current) => {
      const kept: Record<string, string> = {};
      for (const field of PARAM_FIELDS) {
        const value = current[field.key];
        if (!value) continue;
        const options = enumOptionsFor(nextAgent, field.key);
        if (options === undefined || options.some((option) => option.key === value))
          kept[field.key] = value;
      }
      return kept;
    });
  };

  const handleAgentChange = (nextAgentId: string) => {
    rebaseParams(nextAgentId);
    setAgentId(nextAgentId);
  };

  /**
   * Switching preset switches the agent with it (issue #668). A preset resolves
   * to one specific agent, and that agent's schema is what validates the fields,
   * so the draft is re-based exactly as an agent switch re-bases it. The agent
   * followed is the RESOLVED target rather than the preset's own binding, so a
   * preset redirected by a jig's agent binding lands on the agent that would
   * really start.
   */
  const handlePresetChange = (nextPresetId: string) => {
    const choice = choices.find(
      (candidate) => candidate.selectable && candidate.preset.id === nextPresetId,
    );
    setPresetId(choice?.preset.id ?? NO_PRESET);
    const nextAgentId = choice?.target.agentPluginId;
    if (nextAgentId !== undefined) {
      rebaseParams(nextAgentId);
      setAgentId(nextAgentId);
    }
  };

  const selectedPreset = selectedChoice?.preset;
  const presetApplies =
    selectedPreset?.agentPluginId !== undefined && selectedPreset.agentPluginId === agentId;
  const presetParams = presetApplies ? selectedPreset.params : undefined;

  /** The draft, with inherit-valued fields dropped rather than sent as empty. */
  const draft: Record<string, unknown> = {};
  for (const field of PARAM_FIELDS) {
    const value = params[field.key]?.trim();
    if (value) draft[field.key] = value;
  }

  const trace = buildResolutionTrace({
    appDefaults: agent?.appDefaults ?? {},
    projectOverrides: agent?.overrides ?? {},
    ...(presetParams !== undefined && { presetParams }),
    perLaunch: draft,
  });

  const handleLaunch = () => {
    if (!agent) return;
    onLaunch({
      agentPluginId: agent.id,
      agentName: agent.name,
      perLaunchOverrides: draft,
      ...(presetParams !== undefined &&
        Object.keys(presetParams).length > 0 && { presetOverrides: presetParams }),
    });
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-md mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              Launch with overrides
            </Heading>
            <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-600">
              One session only. Nothing is saved.
            </p>
          </div>

          <div className="px-5 py-4 space-y-4">
            <div>
              <label htmlFor="launch-overrides-preset" className={LABEL_CLASS}>
                Preset
              </label>
              <select
                id="launch-overrides-preset"
                className={INPUT}
                value={presetId}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                {/* Layer three stays optional, so the pre-#668 behaviour of
                    overriding nothing but the agent is still reachable. */}
                <option value={NO_PRESET}>No preset</option>
                {choices.map(({ preset, target, selectable }) => (
                  <option key={preset.id} value={preset.id} disabled={!selectable}>
                    {selectable
                      ? preset.name
                      : `${preset.name}: ${target.blocked?.message ?? "cannot launch right now."}`}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="launch-overrides-agent" className={LABEL_CLASS}>
                Agent
              </label>
              <select
                id="launch-overrides-agent"
                className={INPUT}
                value={agentId}
                onChange={(e) => handleAgentChange(e.target.value)}
              >
                {launchable.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {PARAM_FIELDS.map((field) => {
                const options = enumOptionsFor(agent, field.key);
                const id = `launch-overrides-${field.key}`;
                return (
                  <div key={field.key}>
                    <label htmlFor={id} className={LABEL_CLASS}>
                      {field.label}
                    </label>
                    {options ? (
                      <select
                        id={id}
                        className={INPUT}
                        value={params[field.key] ?? INHERIT}
                        onChange={(e) =>
                          setParams((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                      >
                        <option value={INHERIT}>inherit</option>
                        {options.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={id}
                        className={INPUT}
                        value={params[field.key] ?? INHERIT}
                        placeholder="inherit"
                        onChange={(e) =>
                          setParams((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/*
             * A named group, not anonymous divs: the "Resolution" caption is
             * the only thing that says what the trace lines beneath it are, so
             * it has to be tied to them programmatically or a screen reader
             * meets four unattributed lines of `key=value` (AP-TC-053 S001-O01,
             * WCAG 1.3.1).
             */}
            <div
              role="group"
              aria-labelledby={RESOLUTION_LABEL_ID}
              data-testid="launch-overrides-resolution"
              className="rounded-lg bg-stone-100 dark:bg-stone-950/60 border border-stone-200 dark:border-stone-800/60 px-3.5 py-2.5"
            >
              <div
                id={RESOLUTION_LABEL_ID}
                className="text-[10px] uppercase tracking-[0.15em] text-stone-400 dark:text-stone-600 font-semibold mb-1.5"
              >
                Resolution
              </div>
              <div className="text-[11px] font-mono leading-relaxed">
                {trace.layers.map((layer) => (
                  // The preset line names the preset that is contributing (issue
                  // #668), so a user who switched presets can read which one the
                  // third layer came from. Only the label changes: the layer id
                  // is the resolution order, not a display concern.
                  <LayerLine
                    key={layer.id}
                    layer={
                      layer.id === "preset" && selectedPreset !== undefined
                        ? { ...layer, label: `${layer.label}: ${selectedPreset.name}` }
                        : layer
                    }
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="px-5 py-3 border-t border-stone-200 dark:border-stone-800/60 flex justify-end gap-2">
            <Button
              onPress={onCancel}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
            >
              Cancel
            </Button>
            <Button
              onPress={handleLaunch}
              isDisabled={agent === undefined}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Bot size={12} />
              Launch session
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
