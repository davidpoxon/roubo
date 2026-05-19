import { useState } from "react";
import { Button, DialogTrigger, Popover } from "react-aria-components";
import { Braces, ArrowRight } from "lucide-react";

import { getGroupedVariables, type TemplateVariableContext } from "./templateDescriptions";
import TemplateVariableReference from "./TemplateVariableReference";

interface TemplateInsertProps {
  ctx: TemplateVariableContext;
  onInsert: (template: string) => void;
}

export default function TemplateInsert({ ctx, onInsert }: TemplateInsertProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const groups = getGroupedVariables(ctx);

  if (groups.every((g) => g.items.length === 0)) return null;

  return (
    <>
      <DialogTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
        <Button
          className="p-1 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors outline-none"
          aria-label="Insert template variable"
        >
          <Braces size={14} />
        </Button>
        <Popover
          placement="bottom end"
          className="w-80 rounded-lg bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 shadow-xl z-50 outline-none"
        >
          <div className="max-h-72 overflow-auto py-1.5">
            {groups.map((group, gi) => (
              <div key={group.category} className={gi > 0 ? "mt-2" : ""}>
                <div className="px-3 pt-1.5 pb-1">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                    {group.label}
                  </span>
                </div>
                {group.items.map((v) => (
                  <Button
                    key={v.syntax}
                    onPress={() => {
                      onInsert(v.syntax);
                      setIsOpen(false);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors group/item outline-none"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <code className="text-[11px] font-mono text-stone-700 dark:text-stone-300">
                        {v.syntax}
                      </code>
                      {v.example &&
                        v.example !== "unavailable" &&
                        v.example !== "Not configured" && (
                          <span className="text-[10px] font-mono text-stone-400 dark:text-stone-600 tabular-nums shrink-0">
                            {v.example.length > 24 ? v.example.slice(0, 24) + "..." : v.example}
                          </span>
                        )}
                    </div>
                    <p className="text-[10px] text-stone-500 dark:text-stone-600 mt-0.5 group-hover/item:text-stone-400 dark:group-hover/item:text-stone-500 transition-colors">
                      {v.description}
                      {v.formula && (
                        <span className="text-stone-400 dark:text-stone-700 group-hover/item:text-stone-500 dark:group-hover/item:text-stone-600">
                          {" "}
                          · {v.formula}
                        </span>
                      )}
                    </p>
                  </Button>
                ))}
              </div>
            ))}
          </div>
          <div className="border-t border-stone-200 dark:border-stone-700/40 px-3 py-2">
            <Button
              onPress={() => {
                setIsOpen(false);
                setShowReference(true);
              }}
              className="flex items-center gap-1.5 text-[10px] text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors outline-none"
            >
              Learn more about template variables
              <ArrowRight size={10} />
            </Button>
          </div>
        </Popover>
      </DialogTrigger>
      <TemplateVariableReference ctx={ctx} isOpen={showReference} onOpenChange={setShowReference} />
    </>
  );
}
