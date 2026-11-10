import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The Delivery tab shows one view at a time (#1620): the map, or a view with a
// breadcrumb back to it. These open a view the way the operator does, from the
// map's rail, and return from one through its breadcrumb.

interface Clicker {
  click: (element: Element) => Promise<void>;
}

// Opens Cost, health and controls from the rail's Burn and health panel.
export async function openCostView(user: Clicker = userEvent): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Cost, health and controls" }));
}

// Opens Decisions and steering from the rail's Decisions panel.
export async function openDecisionsView(user: Clicker = userEvent): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Open the decision pile" }));
}

// Opens Decisions and steering from the rail's Next boundary panel, with the
// focus on the steering note, and returns the link that opened it.
export async function openSteeringView(user: Clicker = userEvent): Promise<HTMLElement> {
  const link = await screen.findByRole("button", { name: "Write a steering note" });
  await user.click(link);
  return link;
}

// Opens the cases view from the header's cases met (#1655).
export async function openCasesView(user: Clicker = userEvent): Promise<void> {
  await user.click(await screen.findByTestId("delivery-header-progress"));
}

// Returns to the map through the Delivery crumb of the view that shows.
export async function returnToMap(user: Clicker = userEvent): Promise<void> {
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  await user.click(within(breadcrumb).getByRole("button", { name: "Delivery" }));
}
