import { AlertTriangle } from "lucide-react";

interface Props {
  pluginRange: string;
  hostApiVersion: string;
}

export default function IncompatibleBanner({ pluginRange, hostApiVersion }: Props) {
  return (
    <div
      role="alert"
      data-testid="plugin-incompatible-banner"
      className="flex items-start gap-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5"
    >
      <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" aria-hidden />
      <p className="text-[13px] text-amber-800 dark:text-amber-300 leading-relaxed">
        This plugin declares Roubo host API <span className="font-mono">{pluginRange}</span>; your
        Roubo provides <span className="font-mono">{hostApiVersion}</span>. Update the plugin or use
        a newer Roubo.
      </p>
    </div>
  );
}
