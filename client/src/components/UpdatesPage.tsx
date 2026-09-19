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
      <h2 className="text-20 font-semibold text-text-primary mb-6">Updates</h2>

      <div className="flex items-start gap-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-bg-surface border border-border shrink-0 mt-0.5">
          <RefreshCw size={16} className="text-text-secondary" />
        </div>

        <div>
          <p className="text-13 font-semibold text-text-primary">Roubo</p>
          {version !== null && (
            <p className="font-mono text-12 text-text-secondary mt-0.5">Version {version}</p>
          )}
          <p className="text-13 text-text-secondary mt-3">
            Roubo checks for updates automatically every hour.
          </p>
        </div>
      </div>
    </div>
  );
}
