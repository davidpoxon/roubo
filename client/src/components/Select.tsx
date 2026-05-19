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
}

export default function Select({
  items,
  value,
  onChange,
  placeholder,
  className,
  allowClear,
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
        aria-label={placeholder ?? "Select"}
      >
        <Button className="w-full flex items-center justify-between rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 transition-colors hover:border-stone-400 dark:hover:border-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600 data-[pressed]:bg-stone-200 dark:data-[pressed]:bg-stone-800">
          <SelectValue className="truncate data-[placeholder]:text-stone-400 dark:data-[placeholder]:text-stone-500">
            {({ isPlaceholder, selectedText }) => {
              if (isPlaceholder) return <span>{placeholder}</span>;
              const match = normalized.find((item) => item.label === selectedText);
              return match?.renderLabel ?? selectedText;
            }}
          </SelectValue>
          <ChevronDown size={16} className="shrink-0 ml-2 text-stone-400 dark:text-stone-600" />
        </Button>
        <Popover className="w-[var(--trigger-width)] rounded-lg bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 shadow-xl py-1 z-50 overflow-auto max-h-60 transition-opacity duration-150 data-[entering]:opacity-0">
          <ListBox className="outline-none">
            {normalized.map((item) => (
              <ListBoxItem
                key={item.value}
                id={item.value}
                textValue={item.label}
                className="flex items-center justify-between px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
              >
                {({ isSelected }) => (
                  <>
                    <span className="truncate">{item.renderLabel ?? item.label}</span>
                    {isSelected && (
                      <Check
                        size={14}
                        className="text-stone-500 dark:text-stone-400 shrink-0 ml-2"
                      />
                    )}
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
          className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded outline-none transition-colors duration-150 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400"
        >
          <X size={14} />
        </Button>
      )}
    </div>
  );
}
