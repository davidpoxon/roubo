import { focusRing } from "../ui/focus-ring";

// The breadcrumb over a view of the Delivery tab other than the map (#1620):
// Bench N / Delivery / the view. The earlier crumbs both return to the map,
// since the views live inside the tab and the bench is the page around it.
export default function DeliveryBreadcrumb({
  benchId,
  current,
  mono = false,
  onReturn,
}: {
  benchId: number;
  current: string;
  // A unit or gate id is set in mono, as on the map.
  mono?: boolean;
  onReturn: () => void;
}) {
  const crumb = `inline-flex min-h-6 items-center rounded-control text-text-secondary hover:text-text-primary ${focusRing}`;
  return (
    <nav aria-label="Breadcrumb" data-testid="delivery-breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12">
        <li>
          <button type="button" onClick={onReturn} className={crumb}>
            Bench {benchId}
          </button>
        </li>
        <li aria-hidden="true" className="text-border-control">
          /
        </li>
        <li>
          <button type="button" onClick={onReturn} className={crumb}>
            Delivery
          </button>
        </li>
        <li aria-hidden="true" className="text-border-control">
          /
        </li>
        <li>
          <span
            aria-current="page"
            className={`text-text-body ${mono ? "font-mono" : ""} wrap-anywhere`}
          >
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}
