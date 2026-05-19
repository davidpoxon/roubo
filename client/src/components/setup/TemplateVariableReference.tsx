import { Dialog, Modal, ModalOverlay, Button, Heading } from "react-aria-components";
import { X } from "lucide-react";
import type { TemplateVariableContext } from "./templateDescriptions";
import { getGroupedVariables, getBenchExamples } from "./templateDescriptions";

interface Props {
  ctx: TemplateVariableContext;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export default function TemplateVariableReference({ ctx, isOpen, onOpenChange }: Props) {
  const groups = getGroupedVariables(ctx);
  const benchExamples = getBenchExamples(ctx, [1, 2, 3]);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none max-h-[80vh] flex flex-col">
          {({ close }) => (
            <>
              <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  Template Variables
                </Heading>
                <Button
                  onPress={close}
                  className="p-1 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none"
                >
                  <X size={16} />
                </Button>
              </div>

              <div className="px-5 py-4 overflow-auto space-y-6">
                <p className="text-xs text-stone-600 dark:text-stone-400 leading-relaxed">
                  Template variables are placeholders in your config values that resolve to
                  bench-specific values at runtime. Each bench gets its own ports, workspace path,
                  and connection strings.
                </p>

                {groups.map((group) => (
                  <section key={group.category} className="space-y-2.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                      {group.label}
                    </h3>

                    {group.items.map((v) => (
                      <div
                        key={v.syntax}
                        className="rounded-lg bg-stone-100 dark:bg-stone-800/40 px-3 py-2.5 space-y-1.5"
                      >
                        <code className="block text-[11px] font-mono text-stone-700 dark:text-stone-300">
                          {v.syntax}
                        </code>
                        <p className="text-[11px] text-stone-500 leading-relaxed">
                          {v.description}
                        </p>
                        {v.formula && (
                          <p className="text-[10px] text-stone-400 dark:text-stone-600">
                            Formula: <code className="font-mono text-stone-500">{v.formula}</code>
                          </p>
                        )}
                      </div>
                    ))}
                  </section>
                ))}

                {benchExamples.length > 0 && (
                  <section className="space-y-2.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                      Port values across benches
                    </h3>
                    <div className="rounded-lg bg-stone-100 dark:bg-stone-800/40 overflow-hidden">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="border-b border-stone-200 dark:border-stone-700/40">
                            <th className="text-left font-medium text-stone-500 px-3 py-2">
                              Variable
                            </th>
                            <th className="text-right font-medium text-stone-500 px-3 py-2">
                              Bench 1
                            </th>
                            <th className="text-right font-medium text-stone-500 px-3 py-2">
                              Bench 2
                            </th>
                            <th className="text-right font-medium text-stone-500 px-3 py-2">
                              Bench 3
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {benchExamples.map((row, i) => (
                            <tr
                              key={row.name}
                              className={
                                i < benchExamples.length - 1
                                  ? "border-b border-stone-200 dark:border-stone-700/20"
                                  : ""
                              }
                            >
                              <td className="px-3 py-2 font-mono text-stone-500 dark:text-stone-400">{`{{ports.${row.name}}}`}</td>
                              {row.values.map((val, j) => (
                                <td
                                  key={j}
                                  className="text-right px-3 py-2 font-mono text-stone-700 dark:text-stone-300 tabular-nums"
                                >
                                  {val}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {ctx.projectName && (
                  <section className="space-y-2.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                      Workspace paths across benches
                    </h3>
                    <div className="rounded-lg bg-stone-100 dark:bg-stone-800/40 px-3 py-2.5 space-y-1">
                      {[1, 2, 3].map((benchNumber) => (
                        <div key={benchNumber} className="flex items-center gap-3">
                          <span className="text-[10px] text-stone-400 dark:text-stone-600 w-10 shrink-0">
                            Bench {benchNumber}
                          </span>
                          <code className="text-[10px] font-mono text-stone-500 dark:text-stone-400 truncate">
                            ~/.roubo/workspaces/{ctx.projectName}/bench-
                            {benchNumber}/
                          </code>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
