import {
  FileText,
  BookOpen,
  ScrollText,
  Sparkles,
  Rocket,
  Bot,
  FlaskConical,
  Hammer,
  Bug,
  Target,
  Flag,
  Flame,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const DEFAULT_BLUEPRINT_ICON = "file-text";

export const BLUEPRINT_ICONS = [
  "file-text",
  "book-open",
  "scroll-text",
  "sparkles",
  "rocket",
  "bot",
  "flask-conical",
  "hammer",
  "bug",
  "target",
  "flag",
  "flame",
];

export const BLUEPRINT_ICON_MAP: Record<string, LucideIcon> = {
  "file-text": FileText,
  "book-open": BookOpen,
  "scroll-text": ScrollText,
  sparkles: Sparkles,
  rocket: Rocket,
  bot: Bot,
  "flask-conical": FlaskConical,
  hammer: Hammer,
  bug: Bug,
  target: Target,
  flag: Flag,
  flame: Flame,
};

export function getBlueprintIcon(name: string): LucideIcon {
  return BLUEPRINT_ICON_MAP[name] ?? FileText;
}
