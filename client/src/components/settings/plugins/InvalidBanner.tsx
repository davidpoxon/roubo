import { AlertCircle } from "lucide-react";

interface Props {
  message: string;
}

export default function InvalidBanner({ message }: Props) {
  return (
    <div
      role="alert"
      data-testid="plugin-invalid-banner"
      className="flex items-start gap-3 rounded-lg border border-danger-border bg-danger-surface px-3 py-2.5"
    >
      <AlertCircle size={16} className="text-danger-text shrink-0 mt-0.5" aria-hidden />
      <p className="text-13 text-danger-text leading-relaxed">{message}</p>
    </div>
  );
}
