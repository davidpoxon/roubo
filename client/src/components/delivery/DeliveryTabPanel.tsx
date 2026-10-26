import type { Bench } from "@roubo/shared";

// The Spec Bench's Delivery tab. For now it names what the bench delivers and how
// it is bound; the delivery views that read the folded snapshot land in this
// panel with later units.
export default function DeliveryTabPanel({ bench }: { bench: Bench }) {
  const specFolder = bench.focusedSpecPath;
  const slug = specFolder?.split("/").filter(Boolean).pop();
  return (
    <div data-testid="delivery-tab-panel" className="space-y-2">
      <p className="text-13 text-text-body">
        Delivering <span className="font-mono text-text-primary">{slug ?? "no spec"}</span>
        {bench.deliveryBindMode && (
          <span className="text-text-secondary">
            {bench.deliveryBindMode === "attach"
              ? " · attached to a running delivery"
              : " · launched from this bench"}
          </span>
        )}
      </p>
      {specFolder && <p className="text-12 font-mono text-text-secondary">{specFolder}</p>}
    </div>
  );
}
