import { Button } from "react-aria-components";
import { Plus } from "lucide-react";
import { useRegisterProjectModal } from "../hooks/useRegisterProjectModal";

export default function RegisterProjectTile() {
  const { open } = useRegisterProjectModal();
  return (
    <Button
      onPress={open}
      className="rounded-control border border-dashed border-border-strong bg-bg-surface p-5 hover:bg-bg-hover transition-colors flex flex-col items-center justify-center gap-2 text-text-secondary hover:text-text-primary min-h-[128px] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
    >
      <Plus size={16} strokeWidth={1.5} />
      <span className="text-12 font-medium">Register project</span>
      <span className="text-11 text-text-secondary">
        Point Roubo at a repo with <span className="font-mono">.roubo/roubo.yaml</span>
      </span>
    </Button>
  );
}
