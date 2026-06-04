import { describe, it, expect } from "vitest";
import { JIG_ICONS, JIG_ICON_MAP, getJigIcon } from "./jigIcons";

describe("jigIcons", () => {
  it("includes the ship icon in the selectable set", () => {
    expect(JIG_ICONS).toContain("ship");
  });

  it("maps the ship icon to a renderable component", () => {
    expect(JIG_ICON_MAP).toHaveProperty("ship");
    expect(JIG_ICON_MAP.ship).toBeDefined();
    expect(getJigIcon("ship")).toBe(JIG_ICON_MAP.ship);
  });

  it("keeps JIG_ICONS and JIG_ICON_MAP in parity", () => {
    const mapKeys = Object.keys(JIG_ICON_MAP);
    // Every selectable name resolves to a mapped icon.
    for (const name of JIG_ICONS) {
      expect(JIG_ICON_MAP).toHaveProperty(name);
    }
    // Every mapped icon is offered in the selectable set.
    for (const key of mapKeys) {
      expect(JIG_ICONS).toContain(key);
    }
    expect(JIG_ICONS).toHaveLength(mapKeys.length);
  });
});
