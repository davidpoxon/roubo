// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import DeliveryBurn from "./DeliveryBurn";
import { DeliveryPanel, DeliveryStatStrip } from "./DeliveryPanel";
import { DeliveryStat } from "./DeliveryProgress";

afterEach(cleanup);

describe("DeliveryPanel", () => {
  it("is a section named by its title, with the title as its heading and the meta beside it", () => {
    render(
      <DeliveryPanel testId="panel" title="Drift ledger" meta="3 entries">
        <p>body</p>
      </DeliveryPanel>,
    );
    const panel = screen.getByRole("region", { name: "Drift ledger" });
    expect(panel).toBe(screen.getByTestId("panel"));
    expect(within(panel).getByRole("heading", { name: "Drift ledger" })).toBeTruthy();
    expect(within(panel).getByText("3 entries")).toBeTruthy();
    expect(within(panel).getByText("body")).toBeTruthy();
  });

  it("renders no meta line when none is given", () => {
    render(
      <DeliveryPanel testId="panel" title="Health">
        <p>body</p>
      </DeliveryPanel>,
    );
    expect(screen.getByTestId("panel").querySelector("header")?.children).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["false", false],
    ["empty", ""],
  ])("renders no meta line for a %s meta", (_label, meta) => {
    render(
      <DeliveryPanel testId="panel" title="Health" meta={meta}>
        <p>body</p>
      </DeliveryPanel>,
    );
    expect(screen.getByTestId("panel").querySelector("header")?.children).toHaveLength(1);
  });

  it("puts its title in a third-level heading", () => {
    render(
      <DeliveryPanel title="Burn">
        <p>body</p>
      </DeliveryPanel>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Burn" })).toBeTruthy();
  });
});

describe("DeliveryStatStrip", () => {
  it("lays its cells out in one column each, up to four", () => {
    render(
      <DeliveryStatStrip testId="strip">
        <DeliveryStat testId="a" eyebrow="Spent" value="1.00" note="of 2.00" />
        <DeliveryStat testId="b" eyebrow="Jams" value={0} note="none" />
        <DeliveryStat testId="c" eyebrow="Cases" value="1 / 3" note="met" />
      </DeliveryStatStrip>,
    );
    const strip = screen.getByTestId("strip");
    expect(strip.className).toContain("grid-cols-3");
    expect(strip.children).toHaveLength(3);
  });

  it("gives a single cell one column", () => {
    render(
      <DeliveryStatStrip testId="strip">
        <DeliveryStat testId="a" eyebrow="Spent" value="1.00" note="of 2.00" />
      </DeliveryStatStrip>,
    );
    expect(screen.getByTestId("strip").className).toContain("grid-cols-1");
  });

  it("does not count a false child as a cell", () => {
    const showJams = false;
    render(
      <DeliveryStatStrip testId="strip">
        <DeliveryStat testId="a" eyebrow="Spent" value="1.00" note="of 2.00" />
        {showJams && <DeliveryStat testId="b" eyebrow="Jams" value={0} note="none" />}
        <DeliveryStat testId="c" eyebrow="Cases" value="1 / 3" note="met" />
      </DeliveryStatStrip>,
    );
    const strip = screen.getByTestId("strip");
    expect(strip.className).toContain("grid-cols-2");
    expect(strip.children).toHaveLength(2);
  });

  it("holds at most four cells", () => {
    render(
      <DeliveryStatStrip testId="strip">
        {["a", "b", "c", "d", "e"].map((id) => (
          <DeliveryStat key={id} testId={id} eyebrow={id} value={1} note="n" />
        ))}
      </DeliveryStatStrip>,
    );
    const strip = screen.getByTestId("strip");
    expect(strip.className).toContain("grid-cols-4");
    expect(strip.children).toHaveLength(4);
  });
});

describe("DeliveryBurn breakdowns", () => {
  it("heads each breakdown one level below the Burn panel", () => {
    render(<DeliveryBurn snapshot={foldDelivery({ record: fourUnitRecord(), events: [] })} />);
    expect(screen.getByRole("heading", { level: 4, name: "Cost per unit" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Cost per role" })).toBeTruthy();
  });
});

describe("DeliveryBurn in its panel", () => {
  it("puts the spent figure in the Burn panel's stat strip and names the estimate and budget", () => {
    render(<DeliveryBurn snapshot={foldDelivery({ record: fourUnitRecord(), events: [] })} />);
    const panel = screen.getByRole("region", { name: "Burn" });
    const strip = within(panel).getByTestId("delivery-burn-stats");
    expect(within(strip).getByTestId("delivery-stat-spent")).toBeTruthy();
    expect(within(panel).getByText(/^estimate \d+\.\d{2} · soft budget \d+\.\d{2}$/)).toBeTruthy();
  });
});
