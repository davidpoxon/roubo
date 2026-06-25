import { ShieldAlert } from "lucide-react";
import type { IsolationNotice } from "@roubo/shared";

interface Props {
  notices: IsolationNotice[];
}

/**
 * Surfaces docker isolation-tier notices (#743) on the plugin card. The plugin
 * keeps running on the broker-only floor, so this is an amber advisory (not a
 * red error): it tells the user the OS-isolation tier could not engage and how
 * to enable it. One banner per notice, each naming the plugin dir and the
 * remediation carried in the notice message.
 */
export default function IsolationNoticeBanner({ notices }: Props) {
  if (notices.length === 0) return null;
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
    </div>
  );
}
