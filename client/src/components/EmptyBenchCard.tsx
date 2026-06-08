import { useState } from "react";
import { Button, Popover, DialogTrigger } from "react-aria-components";
import { useDroppable } from "@dnd-kit/core";
import { Plus, ListTodo, FlaskConical } from "lucide-react";

export default function EmptyBenchCard({
  position,
  onCreateBlank,
  onPickIssue,
  testBenchEnabled = false,
  onCreateTestBench,
}: {
  position: number;
  onCreateBlank: () => void;
  onPickIssue: (position: number) => void;
  // When true (and a handler is supplied), the menu offers a "Create a TestBench"
  // option (#418). Kept presentational: the parent reads the feature flag and owns
  // the spec-picker modal.
  testBenchEnabled?: boolean;
  onCreateTestBench?: (position: number) => void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);

  const { isOver, setNodeRef } = useDroppable({
    id: `empty-bench-${position}`,
    data: { position },
  });

  return (
    <div ref={setNodeRef} className="h-[260px]">
      <DialogTrigger isOpen={popoverOpen} onOpenChange={setPopoverOpen}>
        <Button
          className={`w-full h-full text-left outline-none rounded-xl border-2 border-dashed transition-all duration-200 ${
            isOver
              ? "border-stone-400 dark:border-stone-500 bg-stone-100 dark:bg-stone-800/60 scale-[1.02]"
              : "border-stone-200 dark:border-stone-800/60 hover:border-stone-300 dark:hover:border-stone-700/60 hover:bg-stone-50 dark:hover:bg-stone-900/30"
          }`}
        >
          <div className="p-4 space-y-2.5">
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-stone-300 dark:text-stone-700">
                Bench {position}
              </p>
            </div>
            <p className="text-xs text-stone-300 dark:text-stone-700">Available</p>
          </div>
        </Button>
        <Popover
          placement="bottom start"
          className="rounded-lg bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 shadow-xl py-1 z-50 w-52 transition-opacity duration-150 data-[entering]:opacity-0"
        >
          <div className="py-1">
            <Button
              onPress={() => {
                setPopoverOpen(false);
                onCreateBlank();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none text-left"
            >
              <Plus size={14} className="text-stone-400 dark:text-stone-500" />
              Set up blank bench
            </Button>
            <Button
              onPress={() => {
                setPopoverOpen(false);
                onPickIssue(position);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none text-left"
            >
              <ListTodo size={14} className="text-stone-400 dark:text-stone-500" />
              Pick an issue
            </Button>
            {testBenchEnabled && onCreateTestBench && (
              <Button
                onPress={() => {
                  setPopoverOpen(false);
                  onCreateTestBench(position);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none text-left"
              >
                <FlaskConical size={14} className="text-stone-400 dark:text-stone-500" />
                Create a TestBench
              </Button>
            )}
          </div>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
