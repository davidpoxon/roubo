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
            <div
              className={`text-sm font-medium leading-none mb-1.5 ${isDisabled ? "text-stone-500 dark:text-stone-500" : "text-stone-800 dark:text-stone-200"}`}
            >
              {label}
            </div>
            <div className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed">
              {description}
            </div>
          </div>

          <div
            className={[
              "relative shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-all duration-150",
              isSelected
                ? "bg-stone-700 dark:bg-stone-300 border-stone-700 dark:border-stone-300"
                : "bg-transparent border-stone-300 dark:border-stone-600",
              isFocusVisible
                ? "ring-2 ring-stone-400 dark:ring-stone-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
                : "",
            ].join(" ")}
          >
            <div
              className={[
                "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all duration-150",
                isSelected
                  ? "left-[18px] bg-white dark:bg-stone-900"
                  : "left-0.5 bg-stone-300 dark:bg-stone-600",
              ].join(" ")}
            />
          </div>
        </>
      )}
    </Switch>
  );
}
