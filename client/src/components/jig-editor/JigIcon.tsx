import { JIG_ICON_MAP } from "./jigIcons";
import { FileText } from "lucide-react";

interface Props {
  name: string;
  size?: number;
  className?: string;
}

export default function JigIcon({ name, size = 16, className }: Props) {
  const Icon = JIG_ICON_MAP[name] ?? FileText;
  return <Icon size={size} className={className} />;
}
