import { useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { Bot } from "lucide-react";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { stampAriaModal } from "../lib/aria-modal";
import { INPUT } from "./setup/styles";
import { PARAM_FIELDS, INHERIT, enumOptionsFor } from "./settings/agents/agent-params";
import { agentLaunchBlocker } from "./settings/agents/agent-launchability";
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
   * The preset this launch starts from, when there is one. Its params form the
   * third layer, but only while the selected agent is the one the preset resolves
   * to: a preset's params are validated against that agent's schema, so pointing
   * them at another agent would ship keys its schema never saw (AP-TC-033).
   */
  preset?: ResolvedAgentPreset | null;
  onCancel: () => void;
  onLaunch: (selection: LaunchOverridesSelection) => void;
}

const LABEL_CLASS = "block text-[11px] font-medium text-stone-500 mb-1.5";

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
  preset,
  onCancel,
  onLaunch,
}: Props) {
  // Nothing that cannot launch is offered, exactly as the launch menu gates its
  // rows: the dialog must not be a way around AP-TC-038.
  const launchable = agents.filter((agent) => agentLaunchBlocker(agent) === null);
  const initialAgentId =
    launchable.find((agent) => agent.id === preset?.agentPluginId)?.id ?? launchable[0]?.id ?? "";

  const [agentId, setAgentId] = useState(initialAgentId);
  const [params, setParams] = useState<Record<string, string>>({});

  const agent = launchable.find((candidate) => candidate.id === agentId);
  const presetApplies = preset?.agentPluginId !== undefined && preset.agentPluginId === agentId;
  const presetParams = presetApplies ? preset.params : undefined;

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
              <label htmlFor="launch-overrides-agent" className={LABEL_CLASS}>
                Agent
              </label>
              <select
                id="launch-overrides-agent"
                className={INPUT}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
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
                          <option key={option} value={option}>
                            {option}
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

            <div
              data-testid="launch-overrides-resolution"
              className="rounded-lg bg-stone-100 dark:bg-stone-950/60 border border-stone-200 dark:border-stone-800/60 px-3.5 py-2.5"
            >
              <div className="text-[10px] uppercase tracking-[0.15em] text-stone-400 dark:text-stone-600 font-semibold mb-1.5">
                Resolution
              </div>
              <div className="text-[11px] font-mono leading-relaxed">
                {trace.layers.map((layer) => (
                  <LayerLine key={layer.id} layer={layer} />
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
