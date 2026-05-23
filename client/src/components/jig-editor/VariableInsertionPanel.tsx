import { Button } from "react-aria-components";
import { getJigVariableGroups } from "./jigVariables";

interface Props {
  scope: "global" | "project";
  onInsert: (syntax: string) => void;
}

export default function VariableInsertionPanel({ scope, onInsert }: Props) {
  const groups = getJigVariableGroups(scope);

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
          Variables
        </h3>
        <p className="text-[10px] text-stone-400 dark:text-stone-600 mt-1 leading-relaxed">
          Click to insert at cursor
        </p>
      </div>

      <div className="pb-4">
        {groups.map((group, gi) => (
          <div key={group.category} className={gi > 0 ? "mt-3" : ""}>
            <div className="px-4 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-stone-400 dark:text-stone-600">
                {group.label}
              </span>
            </div>

            {group.items.map((v) => (
              <Button
                key={v.syntax}
                onPress={() => onInsert(v.syntax)}
                className="w-full text-left px-4 py-2 hover:bg-stone-100 dark:hover:bg-stone-800/50 transition-colors outline-none focus-visible:bg-stone-100 dark:focus-visible:bg-stone-800/50"
              >
                <code className="block text-[11px] font-mono text-stone-700 dark:text-stone-300 leading-tight">
                  {v.syntax}
                </code>
                <p className="text-[10px] text-stone-400 dark:text-stone-600 mt-0.5 leading-relaxed">
                  {v.description}
                </p>
                {v.note && (
                  <p className="text-[10px] text-stone-400 dark:text-stone-600 mt-0.5 leading-relaxed italic">
                    {v.note}
                  </p>
                )}
              </Button>
            ))}

            {group.footnote && (
              <p className="px-4 pt-1 pb-0.5 text-[10px] text-stone-400 dark:text-stone-600 leading-relaxed italic">
                {group.footnote}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
