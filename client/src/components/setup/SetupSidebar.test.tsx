// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import SetupSidebar, { type PortConflict } from "./SetupSidebar";
import type { ValidationStatus, ValidationError } from "./SetupValidationPanel";
import type { RouboConfig, Bench } from "@roubo/shared";
import type { ImpactResult } from "./computeImpact";

const baseConfig: Partial<RouboConfig> = {
  project: { name: "test", displayName: "Test", type: "web", repo: "org/test" },
  layout: { type: "single-repo" },
  benches: { max: 9 },
  ports: {
    web: { base: 3000 },
    api: { base: 4000 },
  },
  components: {
    frontend: { type: "process", command: "npm start" },
    backend: { type: "process", command: "npm run dev" },
  },
};

interface RenderOptions {
  config?: Partial<RouboConfig>;
  portConflicts?: PortConflict[];
  saveError?: string;
  rawYaml?: string;
  onOutlineSectionClick?: (key: string, line: number) => void;
  yamlStatus?: ValidationStatus;
  yamlErrors?: ValidationError[];
  lastCheckedAt?: Date;
  onValidate?: () => void;
  isValidating?: boolean;
  impact?: ImpactResult | null;
  benches?: Bench[];
}

function renderSidebar(mode: "guided" | "yaml", opts: RenderOptions = {}) {
  return render(
    <SetupSidebar
      mode={mode}
      config={opts.config ?? baseConfig}
      portConflicts={opts.portConflicts ?? []}
      saveError={opts.saveError}
      rawYaml={opts.rawYaml ?? "project:\n  name: test\n"}
      onOutlineSectionClick={opts.onOutlineSectionClick ?? vi.fn()}
      yamlStatus={opts.yamlStatus ?? "idle"}
      yamlErrors={opts.yamlErrors ?? []}
      lastCheckedAt={opts.lastCheckedAt}
      onValidate={opts.onValidate ?? vi.fn()}
      isValidating={opts.isValidating ?? false}
      impact={opts.impact ?? null}
      benches={opts.benches ?? []}
    />,
  );
}

describe("SetupSidebar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("Outline panel (YAML mode only)", () => {
    it("does not show Outline panel in guided mode", () => {
      renderSidebar("guided");
      expect(screen.queryByText(/^outline$/i)).not.toBeInTheDocument();
    });

    it("shows Outline panel in YAML mode", async () => {
      renderSidebar("yaml");
      await act(async () => {});
      expect(screen.getByText(/^outline$/i)).toBeInTheDocument();
    });

    it("Outline items in YAML mode invoke onOutlineSectionClick", async () => {
      const onOutlineSectionClick = vi.fn();
      renderSidebar("yaml", {
        rawYaml: "project:\n  name: nova\nbenches:\n  max: 3\n",
        onOutlineSectionClick,
      });
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: /benches/ }));
      expect(onOutlineSectionClick).toHaveBeenCalledWith("benches", 3);
    });
  });

  describe("Validation panel", () => {
    it("renders Validation heading", () => {
      renderSidebar("guided");
      expect(screen.getAllByText(/^validation$/i).length).toBeGreaterThan(0);
    });

    it("shows 'Valid' in guided mode when config is clean and no conflicts", () => {
      renderSidebar("guided");
      expect(screen.getByText("Valid")).toBeInTheDocument();
      expect(screen.getByText(/ready to save/i)).toBeInTheDocument();
    });

    it("shows issue count in guided mode when benches.max is 0", () => {
      renderSidebar("guided", {
        config: { ...baseConfig, benches: { max: 0 } },
      });
      expect(screen.getByText(/1 issue/i)).toBeInTheDocument();
      expect(screen.getByText(/benches is incomplete/i)).toBeInTheDocument();
    });

    it("shows port conflict in guided mode", () => {
      renderSidebar("guided", {
        portConflicts: [
          {
            port: "web",
            base: 3000,
            conflictsWith: {
              projectId: "other",
              projectName: "Other",
              port: "web",
              range: [3000, 3099],
            },
          },
        ],
      });
      expect(screen.getByText(/port conflict on "web"/i)).toBeInTheDocument();
    });

    it("shows saveError in guided mode", () => {
      renderSidebar("guided", { saveError: "Something went wrong" });
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });

    it("shows 'Click Check to validate' in YAML idle mode", () => {
      renderSidebar("yaml");
      expect(screen.getByText(/click check to validate/i)).toBeInTheDocument();
    });

    it("shows schema valid status in YAML mode after Check", () => {
      renderSidebar("yaml", {
        yamlStatus: "valid",
        lastCheckedAt: new Date(),
      });
      expect(screen.getByText(/schema valid/i)).toBeInTheDocument();
    });

    it("shows schema errors in YAML mode", () => {
      renderSidebar("yaml", {
        yamlStatus: "errors",
        yamlErrors: [{ path: "project.name", message: "Required" }],
        lastCheckedAt: new Date(),
      });
      expect(screen.getByText(/1 schema error/i)).toBeInTheDocument();
      expect(screen.getByText(/project\.name: Required/)).toBeInTheDocument();
    });

    it("shows saveError in YAML mode", () => {
      renderSidebar("yaml", { saveError: "disk full" });
      expect(screen.getByText("disk full")).toBeInTheDocument();
    });

    it("Check button calls onValidate", () => {
      const onValidate = vi.fn();
      renderSidebar("guided", { onValidate });
      fireEvent.click(screen.getByRole("button", { name: /check/i }));
      expect(onValidate).toHaveBeenCalledTimes(1);
    });
  });

  describe("Summary panel", () => {
    it("renders Summary heading", () => {
      renderSidebar("guided");
      expect(screen.getAllByText(/^summary$/i).length).toBeGreaterThan(0);
    });

    it("shows layout type in Type row", () => {
      renderSidebar("guided");
      expect(screen.getByText("Type")).toBeInTheDocument();
      expect(screen.getByText("single-repo")).toBeInTheDocument();
    });

    it("shows component count from config", () => {
      renderSidebar("guided");
      expect(screen.getByText("Components")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("shows bench cap", () => {
      renderSidebar("guided");
      expect(screen.getByText("Bench cap")).toBeInTheDocument();
      expect(screen.getByText("9")).toBeInTheDocument();
    });
  });

  describe("Impact panel", () => {
    it("renders Impact on benches heading", () => {
      renderSidebar("guided");
      expect(screen.getByText(/impact on benches/i)).toBeInTheDocument();
    });

    it("shows active/idle count from benches prop", () => {
      renderSidebar("guided", {
        benches: [
          { id: 1, status: "active", components: {}, branch: "feat/a" },
        ] as unknown as Bench[],
      });
      // YamlImpactPanel renders "X active · Y idle"
      expect(screen.getByText(/active/)).toBeInTheDocument();
    });
  });
});
