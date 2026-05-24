import { Button } from "react-aria-components";
import { Plus } from "lucide-react";
import { useRegisterProjectModal } from "../hooks/useRegisterProjectModal";

export default function RegisterProjectTile() {
  const { open } = useRegisterProjectModal();
  return (
    <Button
      onPress={open}
      className="rounded-xl border border-dashed border-stone-300 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-900/10 p-5 hover:border-stone-400 dark:hover:border-stone-700 hover:bg-stone-100/50 dark:hover:bg-stone-900/30 transition-all duration-150 flex flex-col items-center justify-center gap-2 text-stone-400 dark:text-stone-500 hover:text-stone-500 dark:hover:text-stone-300 min-h-[128px] outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
    >
      <Plus size={18} strokeWidth={1.5} />
      <span className="text-[12px] font-medium">Register project</span>
      <span className="text-[10px] text-stone-400 dark:text-stone-600">
        Point Roubo at a repo with <span className="font-mono">.roubo/roubo.yaml</span>
      </span>
    </Button>
  );
}
