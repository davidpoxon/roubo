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
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-11 font-medium outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
      >
        <AlertTriangle size={12} />
        YAML: {label}
      </Button>
      <Tooltip className="bg-bg-inverse text-text-on-inverse text-12 px-3 py-1.5 rounded-control shadow-elevation-0 max-w-64 z-50">
        <p>
          YAML contains extra fields ({extraFields.join(", ")}). These fields cannot be preserved by
          saving from Guided mode.
        </p>
      </Tooltip>
    </TooltipTrigger>
  );
}
