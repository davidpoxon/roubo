import { Switch } from "react-aria-components";

export function SettingToggle({
  isSelected,
  onChange,
  isDisabled,
  label,
  description,
}: {
  isSelected: boolean;
  onChange: (val: boolean) => void;
  isDisabled?: boolean;
  label: string;
  description: string;
}) {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      className={`group flex items-start justify-between gap-6 outline-none ${isDisabled ? "opacity-40" : ""}`}
    >
      {({ isFocusVisible }) => (
        <>
          <div className="min-w-0 flex-1">
            <div className="text-13 font-medium leading-none mb-1.5 text-text-primary">{label}</div>
            <div className="text-12 text-text-secondary leading-relaxed">{description}</div>
          </div>

          <div
            className={[
              "relative shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors",
              isSelected ? "bg-accent border-accent" : "bg-transparent border-border-control",
              isFocusVisible ? "ring-2 ring-focus-ring ring-offset-2 ring-offset-bg-base" : "",
            ].join(" ")}
          >
            <div
              className={[
                "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-colors",
                isSelected ? "left-[18px] bg-bg-surface" : "left-0.5 bg-border-control",
              ].join(" ")}
            />
          </div>
        </>
      )}
    </Switch>
  );
}
