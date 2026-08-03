import { Link } from "react-router";
import { Button } from "react-aria-components";
import { Trash2, Pencil, Loader2, FileText, Copy } from "lucide-react";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";
import type { AgentPluginState, JigMeta } from "@roubo/shared";
import { JIG_ICON_MAP } from "./jigIcons";
import Select, { type SelectItem } from "../Select";

/** Sentinel for "no binding, follow the default agent" (AP-FR-006). */
export const DEFAULT_AGENT_VALUE = "__default_agent__";

function JigRowIcon({ icon }: { icon: string }) {
  const Icon = JIG_ICON_MAP[icon] ?? FileText;
  return <Icon size={14} />;
}

interface Props {
  jig: JigMeta;
  editHref: string;
  onDelete: (jig: JigMeta) => void;
  onDuplicate: (jig: JigMeta) => void;
  isDuplicating: boolean;
  /**
   * The selectable agents for this jig's binding (AP-FR-006). Supplied only by
   * the surfaces that offer the binding; omit it and the row renders exactly as
   * it did before.
   */
  agents?: AgentPluginState[];
  /** Called with the chosen plugin id, or `null` to fall back to the default agent. */
  onAgentChange?: (jig: JigMeta, agentPluginId: string | null) => void;
}

export default function JigRow({
  jig,
  editHref,
  onDelete,
  onDuplicate,
  isDuplicating,
  agents,
  onAgentChange,
}: Props) {
  const isBuiltIn = jig.id === GLOBAL_DEFAULT_JIG_ID;
  const showAgentBinding = !isBuiltIn && agents !== undefined && onAgentChange !== undefined;
  // A binding whose plugin is no longer installed (or no longer resolvable)
  // stays visible and named rather than silently reading as "Default agent",
  // because that is the only signal the jig is not launching what it says
  // (AP-TC-035 S001). The launch itself falls back to the default agent.
  const boundAgentUnavailable =
    showAgentBinding &&
    jig.agentPluginId !== undefined &&
    !agents.some((agent) => agent.id === jig.agentPluginId);
  const agentItems: SelectItem[] = showAgentBinding
    ? [
        { value: DEFAULT_AGENT_VALUE, label: "Default agent" },
        ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
        ...(boundAgentUnavailable && jig.agentPluginId !== undefined
          ? [{ value: jig.agentPluginId, label: `${jig.agentPluginId} (unavailable)` }]
          : []),
      ]
    : [];

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30">
      <div className="flex items-center justify-center w-7 h-7 rounded-md bg-stone-100 dark:bg-stone-800 shrink-0 text-stone-500 dark:text-stone-400">
        <JigRowIcon icon={jig.icon} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
          {jig.name}
        </p>
        <p className="text-[11px] text-stone-400 dark:text-stone-600 truncate">{jig.description}</p>
      </div>
      {showAgentBinding && (
        <div className="w-44 shrink-0" data-testid={`jig-agent-select-${jig.id}`}>
          <Select
            items={agentItems}
            value={jig.agentPluginId ?? DEFAULT_AGENT_VALUE}
            onChange={(value) => onAgentChange(jig, value === DEFAULT_AGENT_VALUE ? null : value)}
            ariaLabel={`Agent for ${jig.name}`}
          />
          {boundAgentUnavailable && (
            <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-500">
              Agent unavailable, launches use the default agent.
            </p>
          )}
        </div>
      )}
      {isBuiltIn ? (
        <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
          Built-in
        </span>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <Link
            to={editHref}
            aria-label={`Edit ${jig.name}`}
            className="p-1.5 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors rounded outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
          >
            <Pencil size={13} />
          </Link>
          <Button
            onPress={() => onDuplicate(jig)}
            aria-label={`Duplicate ${jig.name}`}
            isDisabled={isDuplicating}
            className="p-1.5 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors rounded outline-none focus-visible:ring-1 focus-visible:ring-stone-400 disabled:opacity-40"
          >
            {isDuplicating ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
          </Button>
          <Button
            onPress={() => onDelete(jig)}
            aria-label={`Delete ${jig.name}`}
            className="p-1.5 text-stone-400 dark:text-stone-600 hover:text-red-500 dark:hover:text-red-400 transition-colors rounded outline-none focus-visible:ring-1 focus-visible:ring-red-400"
          >
            <Trash2 size={13} />
          </Button>
        </div>
      )}
    </div>
  );
}
