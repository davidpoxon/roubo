import { BLUEPRINT_ICON_MAP } from "./blueprintIcons";
import { FileText } from "lucide-react";

interface Props {
  name: string;
  size?: number;
  className?: string;
}

export default function BlueprintIcon({ name, size = 16, className }: Props) {
  const Icon = BLUEPRINT_ICON_MAP[name] ?? FileText;
  return <Icon size={size} className={className} />;
}
