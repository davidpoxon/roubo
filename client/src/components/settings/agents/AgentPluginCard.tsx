import { useState } from "react";
import { Button } from "react-aria-components";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import type { AgentCompatibilityState, AgentPluginState } from "@roubo/shared";
import AgentConfigForm from "./AgentConfigForm";

const STRINGS = {
  configure: "Configure",
  hide: "Hide",
  versionPrefix: "v",
  ready: "Ready",
  detectedSuffix: "detected",
  versionUndetected: "CLI version not detected yet",
  floorPrefix: "floor",
  ceilingPrefix: "tested <=",
  withinRange: "within tested range",
  aboveCeiling: "above tested ceiling",
  belowFloor: "below required floor",
  probeFailed: "CLI not detected",
  // The CLI-absent state (AP-TC-122). Deliberately says nothing about the
  // install: the plugin IS installed, and claiming otherwise would send a user
  // to reinstall a plugin that is fine. What is missing is the agent's own CLI,
  // so the guidance names that and nothing else.
  cliMissingHeadline: (name: string) => `${name} is installed, but its agent CLI was not detected.`,
  cliMissingGuidance:
    "Install the agent's command-line tool and make sure it is on your PATH, then reopen this screen.",
};

const CHIP_CLASS =
  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0";

/**
 * The compatibility line: the declared window (which the manifest carries, so it
 * renders without ever launching) and the detected CLI version with its verdict
 * chip (AP-TC-113, AP-TC-114).
 *
 * `unknown` gets no chip at all. It is the state before any launch has probed
 * this agent, and dressing it as a verdict would claim a check that never ran.
 */
function CompatibilityLine({
  agentId,
  compatibility,
}: {
  agentId: string;
  compatibility: AgentCompatibilityState;
}) {
  const { minVersion, testedCeiling, detectedVersion, status } = compatibility;
  const bounds = [
    minVersion && `${STRINGS.floorPrefix} ${minVersion}`,
    testedCeiling && `${STRINGS.ceilingPrefix} ${testedCeiling}`,
  ].filter(Boolean);

  const chip =
    status === "above-tested-ceiling"
      ? { label: STRINGS.aboveCeiling, warn: true }
      : status === "below-floor"
        ? { label: STRINGS.belowFloor, warn: true }
        : status === "probe-failed"
          ? { label: STRINGS.probeFailed, warn: true }
          : status === "within-tested-range"
            ? { label: STRINGS.withinRange, warn: false }
            : null;

  return (
    <div
      data-testid={`agent-compatibility-${agentId}`}
      data-status={status}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-[11px] font-mono text-stone-500 dark:text-stone-400">
        {detectedVersion
          ? `${detectedVersion} ${STRINGS.detectedSuffix}`
          : STRINGS.versionUndetected}
      </span>
      {bounds.length > 0 && (
        <span className="text-[11px] font-mono text-stone-400 dark:text-stone-600">
          {bounds.join(" · ")}
        </span>
      )}
      {chip && (
        <span
          className={`${CHIP_CLASS} ${
            chip.warn
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
              : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400"
          }`}
        >
          {chip.warn ? (
            <TriangleAlert size={10} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={10} aria-hidden="true" />
          )}
          {chip.label}
        </span>
      )}
    </div>
  );
}

/**
 * The unconfigured, CLI-not-detected state (AP-TC-122).
 *
 * An agent plugin installs and resolves perfectly well on a machine that does
 * not have the agent's CLI: the availability chain
 * (server/services/agent-plugin-registry.ts) is about the PLUGIN (installed,
 * compatible, consented, running) and has no notion of the binary. So without
 * this branch the card said "Ready" for an agent that cannot launch, and the
 * only trace of the problem was an unexplained "version check failed" chip.
 *
 * The probe reports that case as `probe-failed` with a `reason` naming what it
 * tried and what happened (an unresolvable command, a nonzero exit, unparseable
 * output). The reason is shown verbatim rather than paraphrased, because it is
 * the only thing that distinguishes "no such binary" from "the binary printed
 * something we could not read", and the fix differs.
 */
function CliNotDetected({ agent }: { agent: AgentPluginState }) {
  return (
    <div
      role="status"
      data-testid={`agent-cli-missing-${agent.id}`}
      className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed space-y-1"
    >
      <p className="font-medium">{STRINGS.cliMissingHeadline(agent.name)}</p>
      {agent.compatibility?.reason && (
        <p data-testid={`agent-cli-missing-reason-${agent.id}`} className="font-mono">
          {agent.compatibility.reason}
        </p>
      )}
      <p>{STRINGS.cliMissingGuidance}</p>
    </div>
  );
}

const DISCLOSURE_BUTTON_CLASS =
  "inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded text-stone-600 dark:text-stone-300 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

/**
 * One installed agent plugin on the AI Agents screen: identity, availability,
 * and a disclosure holding that plugin's own schema-driven config form.
 *
 * The card is keyed by plugin id and owns nothing shared, so six installed
 * agents render six independent cards with six independent forms (AP-TC-015).
 */
export default function AgentPluginCard({ agent }: { agent: AgentPluginState }) {
  // Expanded by default: the screen's whole purpose is the per-plugin config,
  // so the form is the content, not a secondary action. The disclosure exists
  // to collapse a card once a user has many agents installed.
  const [open, setOpen] = useState(true);
  // The disclosure's state and target have to be programmatic, not only drawn
  // as a chevron: without them a screen reader hears "Hide" with no notion that
  // it collapses anything (AP-TC-127, WCAG 4.1.2).
  const panelId = `agent-config-panel-${agent.id}`;
  // Ordered behind `unavailable`: a plugin blocked at the registry (incompatible,
  // unconsented, not running) has a nearer cause than a missing binary, and
  // showing both would offer two fixes for one card.
  const cliMissing = agent.unavailable === null && agent.compatibility?.status === "probe-failed";

  return (
    <section
      aria-label={agent.name}
      data-testid={`agent-plugin-card-${agent.id}`}
      className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 p-4 space-y-3"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot size={14} className="shrink-0 text-stone-400 dark:text-stone-600" />
            <h4 className="text-sm font-medium text-stone-900 dark:text-stone-100 truncate">
              {agent.name}
            </h4>
            {agent.version && (
              <span className="text-[11px] text-stone-400 dark:text-stone-600 font-mono shrink-0">
                {STRINGS.versionPrefix}
                {agent.version}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-stone-400 dark:text-stone-600 font-mono">
            {agent.id}
          </p>
          {agent.description && (
            <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
              {agent.description}
            </p>
          )}
        </div>
        <Button
          onPress={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-controls={panelId}
          data-testid={`agent-configure-${agent.id}`}
          className={DISCLOSURE_BUTTON_CLASS}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? STRINGS.hide : STRINGS.configure}
        </Button>
      </header>

      {agent.compatibility && (
        <CompatibilityLine agentId={agent.id} compatibility={agent.compatibility} />
      )}

      {agent.unavailable ? (
        <p
          role="status"
          data-testid={`agent-unavailable-${agent.id}`}
          className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed"
        >
          {agent.unavailable.message}
        </p>
      ) : cliMissing ? (
        <CliNotDetected agent={agent} />
      ) : (
        <p className="text-[11px] text-stone-500 dark:text-stone-400">{STRINGS.ready}</p>
      )}

      {open && (
        <div id={panelId} className="pt-2 border-t border-stone-100 dark:border-stone-800">
          <AgentConfigForm agent={agent} />
        </div>
      )}
    </section>
  );
}
