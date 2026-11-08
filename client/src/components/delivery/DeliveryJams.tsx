import { ownValue, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectJammedUnits } from "@roubo/shared/delivery-selectors";

// The jam list (SB-FR-019, SB-US-007): one row per jammed unit, in stack order,
// with the unit's id, its title and the status word that jams it. It reads the
// same jams as the Health chip and the map's jam mark, so a `unit.changed` that
// jams or resumes a unit moves all three with the next delivery frame.
export default function DeliveryJams({ snapshot }: { snapshot: DeliverySnapshot }) {
  const jammed = selectJammedUnits(snapshot);
  return (
    <section data-testid="delivery-jams" aria-label="Jams" className="space-y-1">
      <h3 className="font-mono text-11 font-medium text-text-secondary">Jams</h3>
      {jammed.length === 0 ? (
        <p className="text-12 text-text-secondary">No unit is jammed</p>
      ) : (
        <ul className="space-y-0.5">
          {jammed.map((id) => {
            const unit = ownValue(snapshot.unitsById, id);
            return (
              <li
                key={id}
                data-testid={`delivery-jam-row-${id}`}
                data-unit={id}
                className="flex items-baseline gap-3 border-b border-border py-0.5 text-12"
              >
                <span data-col="unit" className="font-mono text-text-primary">
                  {id}
                </span>
                <span data-col="title" className="truncate text-text-body">
                  {unit?.title ?? ""}
                </span>
                <span data-col="status" className="font-mono text-11 text-text-secondary">
                  {unit?.status ?? ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
