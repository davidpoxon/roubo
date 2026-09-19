// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { Tab, TabList, TabPanel, Tabs } from "./Tabs";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

function Example() {
  return (
    <Tabs defaultSelectedKey="components" disabledKeys={["logs"]}>
      <TabList aria-label="Bench views" className="px-4">
        <Tab id="components">Components</Tab>
        <Tab id="inspections">Inspections</Tab>
        <Tab id="logs">Logs</Tab>
      </TabList>
      <TabPanel id="components" className="p-2">
        Components content
      </TabPanel>
      <TabPanel id="inspections">Inspections content</TabPanel>
      <TabPanel id="logs">Logs content</TabPanel>
    </Tabs>
  );
}

describe("Tabs: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings in ${theme}`, async () => {
      const { container } = renderInTheme(<Example />, theme);
      expectNoAxeFindings(await axe(container));
    });
  }
});

describe("Tabs: token contract", () => {
  it("marks the selected tab with the accent indicator and rises the panel in", () => {
    renderInTheme(<Example />, "light");
    const selected = screen.getByRole("tab", { name: "Components" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(selected.className).toContain("data-[selected]:border-accent");
    expect(selected.className).toContain("data-[selected]:text-text-primary");
    expect(selected.className).toContain("text-text-secondary");
    expect(selected.className).toContain("focus-visible:ring-focus-ring");
    expect(screen.getByRole("tablist").className).toContain("px-4");
    expect(screen.getByRole("tabpanel").className).toContain("animate-rise-in");
  });
});
