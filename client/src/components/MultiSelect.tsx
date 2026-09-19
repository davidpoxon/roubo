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
        className="w-full flex items-center justify-between rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary transition-colors focus:outline-none focus:ring-2 focus:ring-focus-ring data-[pressed]:bg-bg-pressed"
      >
        <span className="truncate">
          {triggerLabel ?? <span className="text-text-secondary">{placeholder}</span>}
        </span>
        <ChevronDown size={16} className="shrink-0 ml-2 text-text-secondary" />
      </Button>
      {selectedKeys.size > 0 && (
        <Button
          aria-label="Clear selection"
          onPress={() => onChange(new Set())}
          className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded-control text-text-secondary transition-colors duration-150 hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
              className="flex items-center justify-between px-3 py-1.5 text-13 text-text-body outline-none cursor-default transition-colors data-[hovered]:bg-bg-hover data-[focused]:bg-bg-hover data-[selected]:text-text-primary"
            >
              {({ isSelected }) => (
                <>
                  <span className="truncate">{item.label}</span>
                  {isSelected && <Check size={14} className="text-accent shrink-0 ml-2" />}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </div>
  );
}
