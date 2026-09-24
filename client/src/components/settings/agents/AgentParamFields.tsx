import { useId } from "react";
import { Loader2 } from "lucide-react";
import type { AgentChoiceProbeState } from "@roubo/shared";
import { INPUT } from "../../setup/styles";
import {
  PROBE_FAILED_PLACEHOLDER,
  PROBE_LOADING_PLACEHOLDER,
  PROBE_LOADING_TEXT,
  probeFailureCopy,
} from "../../probe-state-copy";
import { PARAM_FIELDS, INHERIT, enumOptionsFor, pendingProbe } from "./agent-params";

const LABEL_CLASS = "block text-11 font-medium text-text-secondary mb-1.5";

interface Props {
  /** The agent whose schema and choice probes shape the fields; none renders free text. */
  agent:
    | {
        configSchema?: Record<string, unknown>;
        choiceProbes?: Record<string, AgentChoiceProbeState>;
      }
    | undefined;
  params: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Each control's id is `<idPrefix>-<key>`, so a caller's `<label>` lookups stay stable. */
  idPrefix: string;
}

/**
 * The Model, Effort and Mode override fields both override dialogs offer: the
 * agent tool editor (#1057) and the per-launch dialog (#1072). One component,
 * so the two cannot drift in which control a field gets.
 *
 * A field with a closed choice list is a select, and any other field is free
 * text. The exception is a probe-bound field whose probe is still loading or
 * has failed (#1365). It gets a read-only control that stays in the tab order
 * and holds the same placeholder the AI Agents screen shows. A status line
 * beneath the grid carries the loading text, or the failure's cause and remedy,
 * from the same copy (APCC-FR-003, APCC-TC-016, APCC-TC-023). The status spans
 * the grid rather than sitting in the field's third of the dialog, which is too
 * narrow for the failure copy. It is keyed by field, so one `role="status"`
 * region persists from loading to failed and the failure is announced
 * (APCC-TC-022).
 */
export default function AgentParamFields({ agent, params, onChange, idPrefix }: Props) {
  const statusPrefix = useId();
  const pending = PARAM_FIELDS.flatMap((field) => {
    const probe = pendingProbe(agent, field.key);
    return probe ? [{ field, probe }] : [];
  });

  return (
    <div className="grid grid-cols-3 gap-3">
      {PARAM_FIELDS.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const probe = pendingProbe(agent, field.key);
        const options = probe ? undefined : enumOptionsFor(agent, field.key);
        return (
          <div key={field.key}>
            <label htmlFor={id} className={LABEL_CLASS}>
              {field.label}
            </label>
            {probe ? (
              <input
                id={id}
                readOnly
                aria-disabled="true"
                aria-describedby={`${statusPrefix}-${field.key}`}
                data-probe-state={probe.state}
                className={`${INPUT} opacity-40 cursor-not-allowed text-text-secondary`}
                value={
                  probe.state === "loading" ? PROBE_LOADING_PLACEHOLDER : PROBE_FAILED_PLACEHOLDER
                }
              />
            ) : options ? (
              <select
                id={id}
                className={INPUT}
                value={params[field.key] ?? INHERIT}
                onChange={(e) => onChange(field.key, e.target.value)}
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
                onChange={(e) => onChange(field.key, e.target.value)}
              />
            )}
          </div>
        );
      })}

      {pending.map(({ field, probe }) => {
        const loading = probe.state === "loading";
        const failure = loading ? undefined : probeFailureCopy(probe.cause, probe.reason);
        return (
          <div
            key={field.key}
            id={`${statusPrefix}-${field.key}`}
            role="status"
            data-testid={`${idPrefix}-${field.key}-probe-status`}
            className={`col-span-3 flex items-start gap-1.5 text-11 leading-relaxed ${
              loading ? "text-text-secondary" : "text-danger-text"
            }`}
          >
            {loading ? (
              <>
                <Loader2 size={12} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin" />
                <span>
                  {field.label}: {PROBE_LOADING_TEXT}
                </span>
              </>
            ) : (
              <span>
                <span className="block font-medium">
                  {field.label}: {failure?.cause}
                </span>
                <span className="block text-text-body">{failure?.remedy}</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
