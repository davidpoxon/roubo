import { TextField, Label, Input } from "react-aria-components";
import type { BenchesConfig, PortConfig } from "@roubo/shared";
import type { WizardAction } from "./wizardReducer";

interface Props {
  benches: Partial<BenchesConfig>;
  ports: Record<string, PortConfig>;
  dispatch: React.Dispatch<WizardAction>;
}

export default function SectionBenches({ benches, ports, dispatch }: Props) {
  const max = benches.max ?? 0;

  const portEntries = Object.entries(ports);

  return (
    <div className="space-y-5">
      <TextField
        value={String(max || "")}
        onChange={(v) =>
          dispatch({
            type: "UPDATE_BENCHES",
            payload: { ...benches, max: parseInt(v, 10) || 0 },
          })
        }
      >
        <Label className="block text-xs text-stone-500 mb-1.5">Maximum concurrent benches</Label>
        <Input
          type="number"
          min={1}
          max={99}
          placeholder="9"
          className="w-24 rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600"
        />
        {max > 0 && (max < 1 || max > 99) && (
          <p className="mt-1 text-[11px] text-red-400">Must be between 1 and 99</p>
        )}
      </TextField>

      <TextField
        value={benches.setup ?? ""}
        onChange={(v) =>
          dispatch({
            type: "UPDATE_BENCHES",
            payload: {
              ...benches,
              max: benches.max ?? 0,
              setup: v || undefined,
            },
          })
        }
      >
        <Label className="block text-xs text-stone-500 mb-1.5">Setup command</Label>
        <Input
          placeholder="e.g. cd app && npm ci"
          className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600"
        />
        <p className="text-[10px] text-stone-500 mt-1">
          Runs once at workspace root before components start, through your login shell, so shell
          syntax works (e.g. <span className="font-mono">cd app &amp;&amp; npm ci</span>)
        </p>
      </TextField>

      {max > 0 && portEntries.length > 0 && (
        <div>
          <label className="block text-xs text-stone-500 mb-2">Port ranges</label>
          <div className="space-y-1">
            {portEntries.map(([name, port]) => (
              <div key={name} className="flex items-center gap-3 text-[12px] font-mono">
                <span className="text-stone-500 dark:text-stone-400 shrink-0">{name}</span>
                <span className="text-stone-400 dark:text-stone-600 tabular-nums">
                  {port.base} – {port.base + max - 1}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
