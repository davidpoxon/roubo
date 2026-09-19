import { AlertTriangle } from "lucide-react";

const STRINGS = {
  declares: "This plugin declares Roubo host API ",
  provides: "; your Roubo provides ",
  resolution: ". Update the plugin or use a newer Roubo.",
};

interface Props {
  pluginRange: string;
  hostApiVersion: string;
}

export default function IncompatibleBanner({ pluginRange, hostApiVersion }: Props) {
  return (
    <div
      role="alert"
      data-testid="plugin-incompatible-banner"
      className="flex items-start gap-3 rounded-lg border border-accent-border bg-accent-muted px-3 py-2.5"
    >
      <AlertTriangle size={16} className="text-accent-text shrink-0 mt-0.5" aria-hidden />
      <p className="text-13 text-accent-text leading-relaxed">
        {STRINGS.declares}
        <span className="font-mono">{pluginRange}</span>
        {STRINGS.provides}
        <span className="font-mono">{hostApiVersion}</span>
        {STRINGS.resolution}
      </p>
    </div>
  );
}
