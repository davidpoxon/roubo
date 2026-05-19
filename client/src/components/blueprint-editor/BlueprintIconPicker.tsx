import { Button, DialogTrigger, Popover, Dialog } from "react-aria-components";
import { BLUEPRINT_ICONS } from "./blueprintIcons";
import BlueprintIcon from "./BlueprintIcon";

interface Props {
  value: string;
  onChange: (icon: string) => void;
}

function IconOption({
  name,
  isSelected,
  onPress,
}: {
  name: string;
  isSelected: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      aria-label={name}
      aria-pressed={isSelected}
      onPress={onPress}
      className={[
        "flex items-center justify-center w-7 h-7 rounded-md transition-colors duration-150 outline-none",
        "focus-visible:ring-1 focus-visible:ring-stone-400 dark:focus-visible:ring-stone-600",
        isSelected
          ? "bg-amber-500 text-stone-950"
          : "text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700/50",
      ].join(" ")}
    >
      <BlueprintIcon name={name} size={14} />
    </Button>
  );
}

export default function BlueprintIconPicker({ value, onChange }: Props) {
  return (
    <DialogTrigger>
      <Button
        aria-label="Pick icon"
        className="flex items-center justify-center w-9 h-9 rounded-lg border border-stone-300 dark:border-stone-700/50 bg-stone-100 dark:bg-stone-800/60 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700/60 transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-stone-400 dark:focus-visible:ring-stone-600"
      >
        <BlueprintIcon name={value} size={16} />
      </Button>
      <Popover
        placement="bottom start"
        className="w-56 rounded-lg bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 shadow-xl z-50 outline-none p-3 transition-opacity duration-150 data-[entering]:opacity-0"
      >
        <Dialog aria-label="Icon picker" className="outline-none">
          <div className="grid grid-cols-6 gap-1.5">
            {BLUEPRINT_ICONS.map((iconName) => (
              <IconOption
                key={iconName}
                name={iconName}
                isSelected={iconName === value}
                onPress={() => onChange(iconName)}
              />
            ))}
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
