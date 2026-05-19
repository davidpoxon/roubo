import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

export default function UpdatesPage() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.roubo
      ?.getAppVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
  }, []);

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100 mb-6">Updates</h2>

      <div className="flex items-start gap-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-stone-100 dark:bg-stone-800/80 border border-stone-200 dark:border-stone-700/50 shrink-0 mt-0.5">
          <RefreshCw size={18} className="text-stone-400 dark:text-stone-500" />
        </div>

        <div>
          <p className="text-[13px] font-semibold text-stone-800 dark:text-stone-200">Roubo</p>
          {version !== null && (
            <p className="font-mono text-[12px] text-stone-500 dark:text-stone-400 mt-0.5">
              Version {version}
            </p>
          )}
          <p className="text-[13px] text-stone-500 dark:text-stone-400 mt-3">
            Roubo checks for updates automatically every hour.
          </p>
        </div>
      </div>
    </div>
  );
}
