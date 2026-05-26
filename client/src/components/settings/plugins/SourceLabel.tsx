import type { PluginSource } from "@roubo/shared";

const STRINGS = {
  bundled: "Bundled",
  userPath: (pluginId: string) => `~/.roubo/plugins/${pluginId}/`,
};

interface Props {
  source: PluginSource;
  pluginId: string;
}

export default function SourceLabel({ source, pluginId }: Props) {
  if (source === "bundled") {
    return (
      <span
        data-testid="plugin-source-label"
        data-source="bundled"
        className="text-[11px] text-stone-500 dark:text-stone-400"
      >
        {STRINGS.bundled}
      </span>
    );
  }
  return (
    <span
      data-testid="plugin-source-label"
      data-source="user"
      className="font-mono text-[11px] text-stone-500 dark:text-stone-400"
    >
      {STRINGS.userPath(pluginId)}
    </span>
  );
}
