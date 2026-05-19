import { TooltipTrigger, Tooltip, Button } from "react-aria-components";
import { AlertTriangle } from "lucide-react";

interface Props {
  extraFields: string[];
}

export default function ExtraFieldsIndicator({ extraFields }: Props) {
  if (extraFields.length === 0) return null;

  const count = extraFields.length;
  const label = count === 1 ? "1 extra field" : `${count} extra fields`;

  return (
    <TooltipTrigger delay={300}>
      <Button
        data-testid="extra-fields-indicator"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-[11px] font-medium outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-amber-500 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
      >
        <AlertTriangle size={11} />
        YAML: {label}
      </Button>
      <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-3 py-2 rounded-md shadow-lg max-w-64 z-50">
        <p>
          YAML contains extra fields ({extraFields.join(", ")}). These fields cannot be preserved by
          saving from Guided mode.
        </p>
      </Tooltip>
    </TooltipTrigger>
  );
}
