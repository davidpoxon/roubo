import { Button } from "react-aria-components";
import { Check, ShieldAlert } from "lucide-react";
import type { IsolationNotice, PluginSource } from "@roubo/shared";
import { useReinstallShared } from "../../../hooks/usePlugins";

interface Props {
  notices: IsolationNotice[];
  /** Plugin id, used to trigger the shared-location reinstall (issue #756). */
  pluginId: string;
  /** Plugin source: the reinstall action is offered only for bundled plugins. */
  source: PluginSource;
}

const STRINGS = {
  reinstall: "Reinstall in shared location",
  reinstalling: "Reinstalling…",
  reinstalled: "Reinstalled in shared location",
};

const ACTION_BUTTON_CLASS =
  "self-start px-2.5 py-1 text-xs font-medium rounded-md border border-amber-300 dark:border-amber-800/60 text-amber-800 dark:text-amber-200 not-disabled:hover:bg-amber-100 dark:not-disabled:hover:bg-amber-900/30 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

/**
 * Surfaces docker isolation-tier notices (#743) on the plugin card. The plugin
 * keeps running on the broker-only floor, so this is an amber advisory (not a
 * red error): it tells the user the OS-isolation tier could not engage and how
 * to enable it. One banner per notice, each naming the plugin dir and the
 * remediation carried in the notice message.
 *
 * Issue #756: when the plugin is bundled and at least one notice is a
 * `docker-mount-unshared` notice, offer a one-click "Reinstall in shared
 * location" action. It copies the bundled plugin into `~/.roubo/plugins/<id>/`
 * (already a shared path), supersedes the bundled entry, and starts the user
 * copy so OS-level isolation can engage. The action is absent for user plugins
 * and for notices of any other kind.
 */
export default function IsolationNoticeBanner({ notices, pluginId, source }: Props) {
  const reinstall = useReinstallShared();
  if (notices.length === 0) return null;

  const offerReinstall =
    source === "bundled" && notices.some((n) => n.kind === "docker-mount-unshared");
  const reinstalled = reinstall.isSuccess;

  return (
    <div className="flex flex-col gap-2" data-testid="plugin-isolation-notices">
      {notices.map((notice) => (
        <div
          key={`${notice.kind}:${notice.pluginDir}`}
          role="status"
          data-testid="plugin-isolation-notice"
          className="flex items-start gap-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5"
        >
          <ShieldAlert size={16} className="text-amber-500 shrink-0 mt-0.5" aria-hidden />
          <p className="min-w-0 break-words text-[13px] text-amber-800 dark:text-amber-300 leading-relaxed">
            {notice.message}
          </p>
        </div>
      ))}

      {offerReinstall &&
        (reinstalled ? (
          <p
            data-testid="plugin-reinstall-shared-done"
            role="status"
            className="flex items-center gap-1.5 self-start text-xs font-medium text-green-700 dark:text-green-400"
          >
            <Check size={14} aria-hidden />
            {STRINGS.reinstalled}
          </p>
        ) : (
          <Button
            data-testid="plugin-reinstall-shared"
            isDisabled={reinstall.isPending}
            onPress={() => reinstall.mutate(pluginId)}
            className={ACTION_BUTTON_CLASS}
          >
            {reinstall.isPending ? STRINGS.reinstalling : STRINGS.reinstall}
          </Button>
        ))}
    </div>
  );
}
