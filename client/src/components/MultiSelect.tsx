import { useRef, useState } from "react";
import { Button, ListBox, ListBoxItem, Popover } from "react-aria-components";
import { Check, ChevronDown, X } from "lucide-react";
import type { Selection } from "react-aria-components";

interface MultiSelectProps {
  items: { value: string; label: string }[];
  selectedKeys: Set<string>;
  onChange: (keys: Set<string>) => void;
  placeholder?: string;
  className?: string;
}

export default function MultiSelect({
  items,
  selectedKeys,
  onChange,
  placeholder,
  className,
}: MultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedLabels = items
    .filter((item) => selectedKeys.has(item.value))
    .map((item) => item.label);

  const triggerLabel =
    selectedLabels.length === 0
      ? null
      : selectedLabels.length <= 2
        ? selectedLabels.join(", ")
        : `${selectedLabels.length} selected`;

  function handleSelectionChange(selection: Selection) {
    if (selection === "all") {
      onChange(new Set(items.map((i) => i.value)));
    } else {
      onChange(new Set(selection as Set<string>));
    }
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <Button
        ref={triggerRef}
        onPress={() => setIsOpen((prev) => !prev)}
        aria-label={placeholder ?? "Select"}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between rounded-control bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-13 text-stone-900 dark:text-stone-200 transition-colors hover:border-stone-400 dark:hover:border-stone-600 focus:outline-none focus:ring-2 focus:ring-focus-ring data-[pressed]:bg-stone-200 dark:data-[pressed]:bg-stone-800"
      >
        <span className="truncate">
          {triggerLabel ?? <span className="text-stone-600">{placeholder}</span>}
        </span>
        <ChevronDown size={16} className="shrink-0 ml-2 text-stone-600 dark:text-stone-300" />
      </Button>
      {selectedKeys.size > 0 && (
        <Button
          aria-label="Clear selection"
          onPress={() => onChange(new Set())}
          className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded-control text-stone-600 dark:text-stone-300 transition-colors duration-150 hover:text-stone-600 dark:hover:text-stone-400 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <X size={14} />
        </Button>
      )}

      <Popover
        triggerRef={triggerRef}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        className="animate-rise-in w-[var(--trigger-width)] rounded-control bg-bg-surface border border-border shadow-elevation-0 py-1 z-50 overflow-auto max-h-60"
      >
        <ListBox
          selectionMode="multiple"
          selectionBehavior="toggle"
          selectedKeys={selectedKeys}
          onSelectionChange={handleSelectionChange}
          className="outline-none"
          aria-label={placeholder ?? "Select"}
        >
          {items.map((item) => (
            <ListBoxItem
              key={item.value}
              id={item.value}
              textValue={item.label}
              className="flex items-center justify-between px-3 py-1.5 text-13 text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
            >
              {({ isSelected }) => (
                <>
                  <span className="truncate">{item.label}</span>
                  {isSelected && (
                    <Check size={14} className="text-stone-500 dark:text-stone-400 shrink-0 ml-2" />
                  )}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </div>
  );
}
