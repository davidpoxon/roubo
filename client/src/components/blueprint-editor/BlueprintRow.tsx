import { Link } from "react-router-dom";
import { Button } from "react-aria-components";
import { Trash2, Pencil, Loader2, FileText, Copy } from "lucide-react";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import type { BlueprintMeta } from "@roubo/shared";
import { BLUEPRINT_ICON_MAP } from "./blueprintIcons";

function BlueprintRowIcon({ icon }: { icon: string }) {
  const Icon = BLUEPRINT_ICON_MAP[icon] ?? FileText;
  return <Icon size={14} />;
}

interface Props {
  blueprint: BlueprintMeta;
  editHref: string;
  onDelete: (blueprint: BlueprintMeta) => void;
  onDuplicate: (blueprint: BlueprintMeta) => void;
  isDuplicating: boolean;
}

export default function BlueprintRow({
  blueprint,
  editHref,
  onDelete,
  onDuplicate,
  isDuplicating,
}: Props) {
  const isBuiltIn = blueprint.id === GLOBAL_DEFAULT_BLUEPRINT_ID;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30">
      <div className="flex items-center justify-center w-7 h-7 rounded-md bg-stone-100 dark:bg-stone-800 shrink-0 text-stone-500 dark:text-stone-400">
        <BlueprintRowIcon icon={blueprint.icon} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
          {blueprint.name}
        </p>
        <p className="text-[11px] text-stone-400 dark:text-stone-600 truncate">
          {blueprint.description}
        </p>
      </div>
      {isBuiltIn ? (
        <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
          Built-in
        </span>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <Link
            to={editHref}
            aria-label={`Edit ${blueprint.name}`}
            className="p-1.5 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors rounded outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
          >
            <Pencil size={13} />
          </Link>
          <Button
            onPress={() => onDuplicate(blueprint)}
            aria-label={`Duplicate ${blueprint.name}`}
            isDisabled={isDuplicating}
            className="p-1.5 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors rounded outline-none focus-visible:ring-1 focus-visible:ring-stone-400 disabled:opacity-40"
          >
            {isDuplicating ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
          </Button>
          <Button
            onPress={() => onDelete(blueprint)}
            aria-label={`Delete ${blueprint.name}`}
            className="p-1.5 text-stone-400 dark:text-stone-600 hover:text-red-500 dark:hover:text-red-400 transition-colors rounded outline-none focus-visible:ring-1 focus-visible:ring-red-400"
          >
            <Trash2 size={13} />
          </Button>
        </div>
      )}
    </div>
  );
}
