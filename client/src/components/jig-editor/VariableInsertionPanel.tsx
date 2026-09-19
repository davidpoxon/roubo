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
        <h3 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
          Variables
        </h3>
        <p className="text-11 text-text-secondary mt-1 leading-relaxed">
          Click to insert at cursor
        </p>
      </div>

      <div className="pb-4">
        {groups.map((group, gi) => (
          <div key={group.category} className={gi > 0 ? "mt-3" : ""}>
            <div className="px-4 py-1">
              <span className="text-11 font-semibold uppercase tracking-label text-text-secondary">
                {group.label}
              </span>
            </div>

            {group.items.map((v) => (
              <Button
                key={v.syntax}
                onPress={() => onInsert(v.syntax)}
                className="w-full text-left px-4 py-2 hover:bg-bg-hover transition-colors outline-none focus-visible:bg-bg-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <code className="block text-11 font-mono text-text-body leading-tight">
                  {v.syntax}
                </code>
                <p className="text-11 text-text-secondary mt-0.5 leading-relaxed">
                  {v.description}
                </p>
                {v.note && (
                  <p className="text-11 text-text-secondary mt-0.5 leading-relaxed italic">
                    {v.note}
                  </p>
                )}
              </Button>
            ))}

            {group.footnote && (
              <p className="px-4 pt-1 pb-0.5 text-11 text-text-secondary leading-relaxed italic">
                {group.footnote}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
