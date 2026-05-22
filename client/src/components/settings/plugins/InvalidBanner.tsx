import { AlertCircle } from "lucide-react";

interface Props {
  message: string;
}

export default function InvalidBanner({ message }: Props) {
  return (
    <div
      role="alert"
      data-testid="plugin-invalid-banner"
      className="flex items-start gap-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2.5"
    >
      <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" aria-hidden />
      <p className="text-[13px] text-red-800 dark:text-red-300 leading-relaxed">{message}</p>
    </div>
  );
}
