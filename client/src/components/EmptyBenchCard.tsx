import { useState } from "react";
import { Button, Popover, DialogTrigger } from "react-aria-components";
import { useDroppable } from "@dnd-kit/core";
import { Plus, ListTodo, FlaskConical } from "lucide-react";
import { MENU_ITEM_CLASS, MENU_POPOVER_CLASS } from "./ui/Menu";
import { focusRingOffset } from "./ui/focus-ring";

// An empty slot has no bench, so its dashed border takes the idle status. Hover
// and drag-over change the ground only, so nothing shifts under the pointer.
const ITEM_CLASS = `w-full text-left ${MENU_ITEM_CLASS}`;
const ICON_CLASS = "text-text-secondary";

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
          className={`w-full h-full text-left rounded-card border border-dashed border-status-idle transition-colors ${focusRingOffset} ${
            isOver ? "bg-bg-hover" : "bg-bg-surface data-[hovered]:bg-bg-hover"
          }`}
        >
          <div className="p-4 space-y-2.5">
            <div className="space-y-0.5">
              <p className="text-14 font-semibold text-text-secondary">Bench {position}</p>
            </div>
            <p className="text-12 text-text-secondary">Available</p>
          </div>
        </Button>
        <Popover placement="bottom start" className={`${MENU_POPOVER_CLASS} z-50 w-52`}>
          <div className="flex flex-col gap-px">
            <Button
              onPress={() => {
                setPopoverOpen(false);
                onCreateBlank();
              }}
              className={ITEM_CLASS}
            >
              <Plus size={14} className={ICON_CLASS} />
              Set up blank bench
            </Button>
            <Button
              onPress={() => {
                setPopoverOpen(false);
                onPickIssue(position);
              }}
              className={ITEM_CLASS}
            >
              <ListTodo size={14} className={ICON_CLASS} />
              Pick an issue
            </Button>
            {testBenchEnabled && onCreateTestBench && (
              <Button
                onPress={() => {
                  setPopoverOpen(false);
                  onCreateTestBench(position);
                }}
                className={ITEM_CLASS}
              >
                <FlaskConical size={14} className={ICON_CLASS} />
                Create a TestBench
              </Button>
            )}
          </div>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
