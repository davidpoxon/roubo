// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SetupValidationPanel from "./SetupValidationPanel";
import type { RouboConfig } from "@roubo/shared";

const validConfig: Partial<RouboConfig> = {
  project: { name: "test", displayName: "Test", type: "web", repo: "org/test" },
  layout: { type: "single-repo" },
  benches: { max: 5 },
  ports: { frontend: { base: 3000 } },
  components: { frontend: { type: "process", command: "npm start" } },
};

const noopValidate = vi.fn();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SetupValidationPanel", () => {
  describe("Guided mode", () => {
    it("shows 'Valid' and 'Ready to save' when config is clean", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={validConfig}
          conflicts={[]}
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText("Valid")).toBeInTheDocument();
      expect(screen.getByText(/ready to save/i)).toBeInTheDocument();
    });

    it("shows issue count when benches.max is 0 (invalid section)", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={{ ...validConfig, benches: { max: 0 } }}
          conflicts={[]}
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/1 issue/i)).toBeInTheDocument();
      expect(screen.getByText(/benches is incomplete/i)).toBeInTheDocument();
    });

    it("shows port conflict message when conflicts present", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={validConfig}
          conflicts={[
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
          ]}
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/port conflict on "web"/i)).toBeInTheDocument();
    });

    it("shows saveError when provided and no other issues", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={validConfig}
          conflicts={[]}
          saveError="Network error"
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });

    it("counts saveError in total alongside invalid sections", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={{ ...validConfig, benches: { max: 0 } }}
          conflicts={[]}
          saveError="Network error"
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/2 issues/i)).toBeInTheDocument();
      expect(screen.getByText(/benches is incomplete/i)).toBeInTheDocument();
    });

    it("shows schema valid status after Check in guided mode", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={validConfig}
          conflicts={[]}
          yamlStatus="valid"
          yamlErrors={[]}
          lastCheckedAt={new Date()}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/schema valid/i)).toBeInTheDocument();
    });

    it("shows schema errors after Check in guided mode", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={validConfig}
          conflicts={[]}
          yamlStatus="errors"
          yamlErrors={[{ path: "project.name", message: "Required" }]}
          lastCheckedAt={new Date()}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/1 schema error/i)).toBeInTheDocument();
    });
  });

  describe("YAML mode", () => {
    it("shows 'Click Check to validate' when status is idle", () => {
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/click check to validate/i)).toBeInTheDocument();
    });

    it("shows pending spinner", () => {
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          yamlStatus="pending"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={true}
        />,
      );
      expect(screen.getByText(/checking/i)).toBeInTheDocument();
    });

    it("shows valid state with lastCheckedAt", () => {
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          yamlStatus="valid"
          yamlErrors={[]}
          lastCheckedAt={new Date()}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/schema valid/i)).toBeInTheDocument();
      expect(screen.getByText(/last checked/i)).toBeInTheDocument();
    });

    it("shows schema errors list", () => {
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          yamlStatus="errors"
          yamlErrors={[
            { path: "project.name", message: "Required" },
            { path: "ports", message: "Must be object", line: 5 },
          ]}
          lastCheckedAt={new Date()}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/2 schema errors/i)).toBeInTheDocument();
      expect(screen.getByText(/project\.name: Required/)).toBeInTheDocument();
      expect(screen.getByText(/roubo\.yaml:5/)).toBeInTheDocument();
    });

    it("shows saveError in YAML mode", () => {
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          saveError="disk full"
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText("disk full")).toBeInTheDocument();
    });

    it("shows port conflicts in YAML mode", () => {
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[
            {
              port: "api",
              base: 4000,
              conflictsWith: {
                projectId: "other",
                projectName: "Other",
                port: "api",
                range: [4000, 4099],
              },
            },
          ]}
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/port conflict on "api"/i)).toBeInTheDocument();
    });
  });

  describe("Last-checked timestamp formatting", () => {
    it("shows 'just now' when checked within 5 seconds", () => {
      vi.spyOn(Date, "now").mockReturnValue(new Date("2025-01-01T12:00:03Z").getTime());
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          yamlStatus="valid"
          yamlErrors={[]}
          lastCheckedAt={new Date("2025-01-01T12:00:00Z")}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/just now/)).toBeInTheDocument();
    });

    it("shows 'Xs ago' when checked more than 5 seconds ago", () => {
      vi.spyOn(Date, "now").mockReturnValue(new Date("2025-01-01T12:00:30Z").getTime());
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          yamlStatus="valid"
          yamlErrors={[]}
          lastCheckedAt={new Date("2025-01-01T12:00:00Z")}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/30s ago/)).toBeInTheDocument();
    });

    it("shows 'Xm ago' when checked more than 60 seconds ago", () => {
      vi.spyOn(Date, "now").mockReturnValue(new Date("2025-01-01T12:02:00Z").getTime());
      render(
        <SetupValidationPanel
          mode="yaml"
          config={validConfig}
          conflicts={[]}
          yamlStatus="valid"
          yamlErrors={[]}
          lastCheckedAt={new Date("2025-01-01T12:00:00Z")}
          onValidate={noopValidate}
          isValidating={false}
        />,
      );
      expect(screen.getByText(/2m ago/)).toBeInTheDocument();
    });
  });

  describe("Check button", () => {
    it("calls onValidate when clicked", () => {
      const onValidate = vi.fn();
      render(
        <SetupValidationPanel
          mode="guided"
          config={validConfig}
          conflicts={[]}
          yamlStatus="idle"
          yamlErrors={[]}
          onValidate={onValidate}
          isValidating={false}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /check/i }));
      expect(onValidate).toHaveBeenCalledTimes(1);
    });

    it("is disabled while isValidating", () => {
      render(
        <SetupValidationPanel
          mode="guided"
          config={validConfig}
          conflicts={[]}
          yamlStatus="pending"
          yamlErrors={[]}
          onValidate={noopValidate}
          isValidating={true}
        />,
      );
      expect(screen.getByRole("button", { name: /check/i })).toBeDisabled();
    });
  });
});
