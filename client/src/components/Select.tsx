import type { ReactNode } from "react";
import {
  Select as AriaSelect,
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
} from "react-aria-components";
import { Check, ChevronDown, X } from "lucide-react";

export interface SelectItem {
  value: string;
  label: string;
  renderLabel?: ReactNode;
}

interface SelectProps {
  items: (string | SelectItem)[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  allowClear?: boolean;
  /** Accessible name, for the cases where the placeholder is not a unique one. */
  ariaLabel?: string;
}

export default function Select({
  items,
  value,
  onChange,
  placeholder,
  className,
  allowClear,
  ariaLabel,
}: SelectProps) {
  const normalized = items.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );

  const hasMatch = normalized.some((item) => item.value === value);

  return (
    <div className={`relative ${className ?? ""}`}>
      <AriaSelect
        selectedKey={hasMatch ? value : null}
        onSelectionChange={(key) => onChange(key as string)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? "Select"}
      >
        <Button className="group w-full flex items-center justify-between rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary transition-colors focus:outline-none focus:ring-2 focus:ring-focus-ring data-[pressed]:bg-bg-pressed">
          <SelectValue className="truncate data-[placeholder]:text-text-secondary group-data-[pressed]:data-[placeholder]:text-text-body">
            {({ isPlaceholder, selectedText }) => {
              if (isPlaceholder) return <span>{placeholder}</span>;
              const match = normalized.find((item) => item.label === selectedText);
              return match?.renderLabel ?? selectedText;
            }}
          </SelectValue>
          <ChevronDown size={16} className="shrink-0 ml-2 text-text-secondary" />
        </Button>
        <Popover className="animate-rise-in w-[var(--trigger-width)] rounded-control bg-bg-surface border border-border shadow-elevation-0 py-1 z-50 overflow-auto max-h-60">
          <ListBox className="outline-none">
            {normalized.map((item) => (
              <ListBoxItem
                key={item.value}
                id={item.value}
                textValue={item.label}
                className="flex items-center justify-between px-3 py-1.5 text-13 text-text-body outline-none cursor-default transition-colors data-[hovered]:bg-bg-hover data-[focused]:bg-bg-hover data-[selected]:text-text-primary"
              >
                {({ isSelected }) => (
                  <>
                    <span className="truncate">{item.renderLabel ?? item.label}</span>
                    {isSelected && <Check size={14} className="text-accent shrink-0 ml-2" />}
                  </>
                )}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </AriaSelect>
      {allowClear && hasMatch && (
        <Button
          aria-label="Clear selection"
          onPress={() => onChange("")}
          className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded-control outline-none transition-colors duration-150 text-text-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <X size={14} />
        </Button>
      )}
    </div>
  );
}
