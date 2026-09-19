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
        <Label className="block text-12 text-text-secondary mb-1.5">
          Maximum concurrent benches
        </Label>
        <Input
          type="number"
          min={1}
          max={99}
          placeholder="9"
          className="w-24 rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
        />
        {max > 0 && (max < 1 || max > 99) && (
          <p className="mt-1 text-11 text-danger-text">Must be between 1 and 99</p>
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
        <Label className="block text-12 text-text-secondary mb-1.5">Setup command</Label>
        <Input
          placeholder="e.g. cd app && npm ci"
          className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
        />
        <p className="text-11 text-text-secondary mt-1">
          Runs once at workspace root before components start, through your login shell, so shell
          syntax works (e.g. <span className="font-mono">cd app &amp;&amp; npm ci</span>)
        </p>
      </TextField>

      {max > 0 && portEntries.length > 0 && (
        <div>
          <label className="block text-12 text-text-secondary mb-2">Port ranges</label>
          <div className="space-y-1">
            {portEntries.map(([name, port]) => (
              <div key={name} className="flex items-center gap-3 text-12 font-mono">
                <span className="text-text-secondary shrink-0">{name}</span>
                <span className="text-text-secondary tabular-nums">
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
