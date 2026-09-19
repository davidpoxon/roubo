import { Button, DialogTrigger, Popover, Dialog } from "react-aria-components";
import { JIG_ICONS } from "./jigIcons";
import JigIcon from "./JigIcon";

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
        "flex items-center justify-center w-7 h-7 rounded-control transition-colors duration-150 outline-none",
        "focus-visible:ring-2 focus-visible:ring-focus-ring",
        isSelected
          ? "bg-accent text-on-accent not-disabled:active:bg-accent-active"
          : "text-text-secondary hover:bg-bg-hover",
      ].join(" ")}
    >
      <JigIcon name={name} size={14} />
    </Button>
  );
}

export default function JigIconPicker({ value, onChange }: Props) {
  return (
    <DialogTrigger>
      <Button
        aria-label="Pick icon"
        className="flex items-center justify-center w-9 h-9 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <JigIcon name={value} size={16} />
      </Button>
      <Popover
        placement="bottom start"
        className="animate-rise-in w-56 rounded-control bg-bg-surface border border-border shadow-elevation-0 z-50 outline-none p-3"
      >
        <Dialog aria-label="Icon picker" className="outline-none">
          <div className="grid grid-cols-6 gap-1.5">
            {JIG_ICONS.map((iconName) => (
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
