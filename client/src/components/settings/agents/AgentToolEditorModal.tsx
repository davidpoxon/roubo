import { useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../../../lib/aria-modal";
import { INPUT } from "../../setup/styles";
import {
  AGENT_TOOL_DEFAULT_AGENT,
  AGENT_TOOL_JIG_INHERIT,
  AGENT_TOOL_JIG_NONE,
} from "@roubo/shared";
import type { AgentPluginState, AgentToolPreset, JigMeta } from "@roubo/shared";
// The three exposed params, the inherit sentinel, and the enum lookup are shared
// with the per-launch override dialog (#518), so both surfaces offer the same
// fields with the same inherit semantics.
import { PARAM_FIELDS, INHERIT, enumOptionsFor } from "./agent-params";

interface Props {
  isOpen: boolean;
  /** The preset being edited, or `null` when creating a new one. */
  preset: AgentToolPreset | null;
  agents: AgentPluginState[];
  /** The agent a `default`-bound preset currently resolves to, if any. */
  defaultAgent?: AgentPluginState;
  jigs: JigMeta[];
  onCancel: () => void;
  onSave: (preset: AgentToolPreset) => void;
}

function initialParams(preset: AgentToolPreset | null): Record<string, string> {
  const params = preset?.params ?? {};
  const seed: Record<string, string> = {};
  for (const field of PARAM_FIELDS) {
    const value = params[field.key];
    seed[field.key] = typeof value === "string" ? value : INHERIT;
  }
  return seed;
}

/**
 * The agent tool editor (AP-FR-008, issue #516).
 *
 * Save writes the preset back to app settings; Cancel closes with nothing
 * written and no toast, so a half-filled draft leaves no list entry behind
 * (AP-TC-040). The form is remounted per open (see the `key` at the call site),
 * which is what makes a cancelled draft unrecoverable rather than merely hidden.
 */
export default function AgentToolEditorModal({
  isOpen,
  preset,
  agents,
  defaultAgent,
  jigs,
  onCancel,
  onSave,
}: Props) {
  const [name, setName] = useState(preset?.name ?? "");
  const [agent, setAgent] = useState(preset?.agent ?? AGENT_TOOL_DEFAULT_AGENT);
  const [jig, setJig] = useState(preset?.jig ?? AGENT_TOOL_JIG_INHERIT);
  const [params, setParams] = useState<Record<string, string>>(() => initialParams(preset));
  const [error, setError] = useState<string | null>(null);

  // A default-bound preset is edited against whichever agent it currently
  // resolves to, so the parameter controls offer that agent's real values
  // rather than a generic free-text box.
  const boundAgent =
    agent === AGENT_TOOL_DEFAULT_AGENT ? defaultAgent : agents.find((a) => a.id === agent);
  // A binding whose plugin is no longer installed keeps an option of its own so
  // the select stays on it and names it, rather than falling back to the first
  // option and silently rewriting the pinned binding to "Default agent" on save
  // (AP-TC-032, issue #650).
  const boundAgentMissing = agent !== AGENT_TOOL_DEFAULT_AGENT && boundAgent === undefined;

  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name is required.");
      return;
    }
    const nextParams: Record<string, unknown> = {};
    for (const field of PARAM_FIELDS) {
      const value = params[field.key]?.trim();
      if (value) nextParams[field.key] = value;
    }
    onSave({
      id: preset?.id ?? "",
      name: trimmed,
      agent,
      params: nextParams,
      ...(jig !== AGENT_TOOL_JIG_INHERIT && { jig }),
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
              Agent tool
            </Heading>
          </div>

          <div className="px-5 py-4 space-y-4">
            <div>
              <label
                htmlFor="agent-tool-name"
                className="block text-[11px] font-medium text-stone-500 mb-1.5"
              >
                Name
              </label>
              <input
                id="agent-tool-name"
                className={INPUT}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder="Deep work"
              />
            </div>

            <div>
              <label
                htmlFor="agent-tool-agent"
                className="block text-[11px] font-medium text-stone-500 mb-1.5"
              >
                Agent
              </label>
              <select
                id="agent-tool-agent"
                className={INPUT}
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                <option value={AGENT_TOOL_DEFAULT_AGENT}>Default agent</option>
                {boundAgentMissing && <option value={agent}>{`${agent} (not installed)`}</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {PARAM_FIELDS.map((field) => {
                const options = enumOptionsFor(boundAgent, field.key);
                const id = `agent-tool-${field.key}`;
                return (
                  <div key={field.key}>
                    <label
                      htmlFor={id}
                      className="block text-[11px] font-medium text-stone-500 mb-1.5"
                    >
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

            <div>
              <label
                htmlFor="agent-tool-jig"
                className="block text-[11px] font-medium text-stone-500 mb-1.5"
              >
                Jig
              </label>
              <select
                id="agent-tool-jig"
                className={INPUT}
                value={jig}
                onChange={(e) => setJig(e.target.value)}
              >
                <option value={AGENT_TOOL_JIG_INHERIT}>Inherit (effective default)</option>
                {jigs.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
                <option value={AGENT_TOOL_JIG_NONE}>None</option>
              </select>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <p className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
              Saved to app settings. Add to{" "}
              <span className="font-mono text-stone-500">roubo.yaml tools:</span> to share it with
              the project.
            </p>
          </div>

          <div className="px-5 py-3 border-t border-stone-200 dark:border-stone-800/60 flex justify-end gap-2">
            <Button
              onPress={onCancel}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
            >
              Cancel
            </Button>
            <Button
              onPress={handleSave}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-stone-950 bg-amber-500 hover:bg-amber-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              Save
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
