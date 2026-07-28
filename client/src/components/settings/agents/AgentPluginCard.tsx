import { useState } from "react";
import { Button } from "react-aria-components";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import type { AgentPluginState } from "@roubo/shared";
import AgentConfigForm from "./AgentConfigForm";

const STRINGS = {
  configure: "Configure",
  hide: "Hide",
  versionPrefix: "v",
  ready: "Ready",
};

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
          data-testid={`agent-configure-${agent.id}`}
          className={DISCLOSURE_BUTTON_CLASS}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? STRINGS.hide : STRINGS.configure}
        </Button>
      </header>

      {agent.unavailable ? (
        <p
          role="status"
          data-testid={`agent-unavailable-${agent.id}`}
          className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed"
        >
          {agent.unavailable.message}
        </p>
      ) : (
        <p className="text-[11px] text-stone-500 dark:text-stone-400">{STRINGS.ready}</p>
      )}

      {open && (
        <div className="pt-2 border-t border-stone-100 dark:border-stone-800">
          <AgentConfigForm agent={agent} />
        </div>
      )}
    </section>
  );
}
