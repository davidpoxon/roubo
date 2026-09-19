// @vitest-environment jsdom
//
// davidpoxon/roubo#1307: axe-core's page-level `region` rule flagged the
// TitleBar `h1` as "Some page content is not contained by landmarks" on
// `/settings#ai-agents` and every other route, because App.tsx renders the
// TitleBar above the sidebar `<aside>` and `<main>` with a plain `<div>` root.
//
// `region` is a page-level rule: axe only runs it when the scan context is the
// whole document, so these tests scan `document.documentElement` rather than
// the render container. The skeleton mirrors App.tsx's layout: TitleBar, the
// optional project declared-source offer (a `role="status"` live region), then
// the sidebar `<aside>` and the route `<main>`.

import { afterEach, describe, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { axe } from "vitest-axe";
import TitleBar from "./TitleBar";
import { expectNoAxeFindings } from "../test/axe";

function AppLayoutSkeleton({
  projectName,
  withOffer = false,
}: {
  projectName?: string;
  withOffer?: boolean;
}) {
  return (
    <div className="flex flex-col h-screen">
      <TitleBar projectName={projectName} />
      {withOffer && (
        <div role="status" aria-label="Register the marketplace declared by responda">
          <p>This project declares a marketplace source.</p>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        <aside aria-label="Projects">
          <nav aria-label="Primary">
            <a href="/settings">Settings</a>
          </nav>
        </aside>
        <main>
          <h2>Settings</h2>
          <p>Route content.</p>
        </main>
      </div>
    </div>
  );
}

afterEach(() => {
  cleanup();
});

async function scanPage() {
  return axe(document.documentElement, { runOnly: { type: "rule", values: ["region"] } });
}

describe("App layout landmarks: axe-core region (roubo#1307)", () => {
  it("contains the ROUBO title heading in a landmark", async () => {
    render(<AppLayoutSkeleton />);
    expectNoAxeFindings(await scanPage());
  });

  it("contains the project name title heading in a landmark", async () => {
    render(<AppLayoutSkeleton projectName="responda" />);
    expectNoAxeFindings(await scanPage());
  });

  it("contains the project declared-source offer in a region", async () => {
    render(<AppLayoutSkeleton projectName="responda" withOffer />);
    expectNoAxeFindings(await scanPage());
  });
});
