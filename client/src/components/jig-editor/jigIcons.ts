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
  Ship,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const DEFAULT_JIG_ICON = "file-text";

export const JIG_ICONS = [
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
  "ship",
];

export const JIG_ICON_MAP: Record<string, LucideIcon> = {
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
  ship: Ship,
};

export function getJigIcon(name: string): LucideIcon {
  return JIG_ICON_MAP[name] ?? FileText;
}
