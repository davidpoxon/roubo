import { Globe, GitFork, Server, Layers, TestTube, Settings, Eye, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  RouboConfig,
  ProjectConfig,
  LayoutConfig,
  ComponentConfig,
  PortConfig,
  ToolConfig,
  InspectionConfig,
  BenchesConfig,
  UserConfig,
  RepoScanResult,
  ConfigValidationResult,
} from "@roubo/shared";

export function nextAvailablePort(
  defaultBase: number,
  ports: Record<string, PortConfig>,
  maxBenches: number,
): number {
  let base = defaultBase;
  const ranges = Object.values(ports).map(
    (p) => [p.base, p.base + Math.max(maxBenches - 1, 0)] as const,
  );
  while (ranges.some(([lo, hi]) => base <= hi && base + Math.max(maxBenches - 1, 0) >= lo)) base++;
  return base;
}

export type WizardSection =
  | "project"
  | "layout"
  | "components"
  | "tools"
  | "users"
  | "inspection"
  | "benches"
  | "review";
export type SectionStatus = "pristine" | "valid" | "invalid";

export const WIZARD_SECTIONS: WizardSection[] = [
  "project",
  "layout",
  "components",
  "tools",
  "users",
  "inspection",
  "benches",
  "review",
];
export const REQUIRED_SECTIONS: WizardSection[] = ["project", "layout", "benches"];

const NAME_PATTERN = /^[a-z0-9-]+$/;

/** Pure validation for each wizard section. Returns undefined when the section has no data yet (pristine). */
export function validateSection(
  section: WizardSection,
  config: Partial<RouboConfig>,
): SectionStatus | undefined {
  switch (section) {
    case "project": {
      // FR-070 (WU-057): `repo` lives in the plugin Configure modal now, not
      // this Identity step, so it is no longer part of the section's validity
      // gate. Name + displayName + type remain required.
      const p = config.project;
      if (!p?.name && !p?.displayName && !p?.type) return undefined;
      return p?.name && NAME_PATTERN.test(p.name) && p.displayName && p.type ? "valid" : "invalid";
    }
    case "layout": {
      // FR-070 (WU-057): `submodules` is edited inside the plugin Configure
      // modal. The setup-wizard layout step only locks in the structure type;
      // an empty submodules map for a meta-repo is allowed at this stage.
      const l = config.layout;
      if (!l?.type) return undefined;
      return "valid";
    }
    case "components": {
      // components and ports are optional. An empty map is valid (a project may
      // have no long-running services); only entries that exist must be complete.
      const components = config.components ?? {};
      const ports = config.ports ?? {};
      const allComponentsValid = Object.values(components).every((c) => {
        if (!c.type) return false;
        if (c.type === "process") return !!c.command?.trim();
        if (c.type === "database")
          return !!c.docker?.composeFile?.trim() && !!c.docker?.service?.trim();
        return true;
      });
      const allPortsValid = Object.values(ports).every((p) => p.base >= 1 && p.base <= 65535);
      return allComponentsValid && allPortsValid ? "valid" : "invalid";
    }
    case "tools": {
      const tools = config.tools ?? [];
      if (tools.length === 0) return "valid";
      return tools.every(
        (l) => l.name && l.icon && l.type && (l.type === "browser" ? l.url : l.command),
      )
        ? "valid"
        : "invalid";
    }
    case "users": {
      const users = config.users;
      if (!users || users.length === 0) return "valid";
      return users.every(
        (u) =>
          !!u.name?.trim() && Object.keys(u.properties ?? {}).every((k) => k.trim().length > 0),
      )
        ? "valid"
        : "invalid";
    }
    case "inspection": {
      const i = config.inspection;
      if (!i) return undefined;
      const allEmpty = !i.framework && !i.directory && !i.command;
      const allFilled = !!(i.framework && i.directory && i.command);
      return allEmpty || allFilled ? "valid" : "invalid";
    }
    case "benches": {
      const max = config.benches?.max;
      if (max == null) return undefined;
      return max >= 1 && max <= 99 ? "valid" : "invalid";
    }
    default:
      return undefined;
  }
}

export const SECTION_ICONS: Record<WizardSection, LucideIcon> = {
  project: Globe,
  layout: GitFork,
  components: Server,
  tools: Layers,
  users: Users,
  inspection: TestTube,
  benches: Settings,
  review: Eye,
};

export const SECTION_LABELS: Record<WizardSection, string> = {
  project: "Project",
  layout: "Layout",
  components: "Components",
  tools: "Tools",
  users: "Users",
  inspection: "Inspection",
  benches: "Benches",
  review: "Review",
};

export interface WizardState {
  config: Partial<RouboConfig>;
  currentSection: WizardSection;
  currentSubStep: string | null;
  sectionStatus: Record<WizardSection, SectionStatus>;
  validationErrors: Record<string, string>;
  touched: Record<string, true>;
  portConflicts: ConfigValidationResult["portConflicts"];
  repoPath: string;
  isEditMode: boolean;
  currentProjectId?: string;
  scanResult?: RepoScanResult;
}

export type WizardAction =
  | { type: "UPDATE_PROJECT"; payload: Partial<ProjectConfig> }
  | { type: "UPDATE_STRUCTURE"; payload: Partial<LayoutConfig> }
  | { type: "SET_COMPONENTS"; payload: Record<string, ComponentConfig> }
  | {
      type: "ADD_COMPONENT";
      payload: { key: string; component: ComponentConfig };
    }
  | { type: "REMOVE_COMPONENT"; payload: string }
  | {
      type: "UPDATE_COMPONENT";
      payload: { key: string; component: ComponentConfig };
    }
  | { type: "RENAME_COMPONENT"; payload: { oldKey: string; newKey: string } }
  | { type: "SET_PORTS"; payload: Record<string, PortConfig> }
  | { type: "ADD_PORT"; payload: { key: string; port: PortConfig } }
  | { type: "REMOVE_PORT"; payload: string }
  | { type: "UPDATE_PORT"; payload: { key: string; port: PortConfig } }
  | { type: "SET_TOOLS"; payload: ToolConfig[] }
  | { type: "SET_USERS"; payload: UserConfig[] }
  | { type: "UPDATE_INSPECTION"; payload: InspectionConfig | undefined }
  | { type: "UPDATE_BENCHES"; payload: BenchesConfig }
  | { type: "SET_SECTION"; payload: WizardSection }
  | {
      type: "SET_SECTION_AND_SUB_STEP";
      payload: { section: WizardSection; subStep: string };
    }
  | { type: "SET_SUB_STEP"; payload: string | null }
  | {
      type: "SET_SECTION_STATUS";
      payload: { section: WizardSection; status: SectionStatus };
    }
  | { type: "SET_VALIDATION_ERRORS"; payload: Record<string, string> }
  | { type: "MERGE_VALIDATION_ERRORS"; payload: Record<string, string> }
  | { type: "MARK_TOUCHED"; payload: string }
  | {
      type: "SET_PORT_CONFLICTS";
      payload: ConfigValidationResult["portConflicts"];
    }
  | { type: "APPLY_SCAN_RESULT"; payload: RepoScanResult }
  | { type: "LOAD_EXISTING_CONFIG"; payload: RouboConfig };

export function createInitialState(
  repoPath: string,
  isEditMode: boolean,
  currentProjectId?: string,
): WizardState {
  const sectionStatus = {} as Record<WizardSection, SectionStatus>;
  for (const s of WIZARD_SECTIONS) sectionStatus[s] = "pristine";

  return {
    config: { benches: { max: 5 } },
    currentSection: "project",
    currentSubStep: null,
    sectionStatus,
    validationErrors: {},
    touched: {},
    portConflicts: [],
    repoPath,
    isEditMode,
    currentProjectId,
  };
}

function resetReview(state: WizardState): WizardState {
  return {
    ...state,
    sectionStatus: { ...state.sectionStatus, review: "pristine" },
  };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "UPDATE_PROJECT":
      return resetReview({
        ...state,
        config: {
          ...state.config,
          project: {
            ...state.config.project,
            ...action.payload,
          } as ProjectConfig,
        },
      });

    case "UPDATE_STRUCTURE":
      return resetReview({
        ...state,
        config: {
          ...state.config,
          layout: { ...state.config.layout, ...action.payload } as LayoutConfig,
        },
      });

    case "SET_COMPONENTS":
      return resetReview({
        ...state,
        config: { ...state.config, components: action.payload },
      });

    case "ADD_COMPONENT": {
      const components = {
        [action.payload.key]: action.payload.component,
        ...state.config.components,
      };
      return resetReview({
        ...state,
        currentSection: "components",
        currentSubStep: action.payload.key,
        config: { ...state.config, components },
      });
    }

    case "REMOVE_COMPONENT": {
      const components = { ...state.config.components };
      Reflect.deleteProperty(components, action.payload);
      const ports = { ...state.config.ports };
      Reflect.deleteProperty(ports, action.payload);
      const nextSubStep =
        state.currentSubStep === action.payload
          ? (Object.keys(components)[0] ?? null)
          : state.currentSubStep;
      return resetReview({
        ...state,
        currentSubStep: nextSubStep,
        config: { ...state.config, components, ports },
      });
    }

    case "UPDATE_COMPONENT": {
      const components = {
        ...state.config.components,
        [action.payload.key]: action.payload.component,
      };
      return resetReview({ ...state, config: { ...state.config, components } });
    }

    case "RENAME_COMPONENT": {
      const { oldKey, newKey } = action.payload;
      const components = { ...state.config.components };
      if (components[oldKey]) {
        components[newKey] = components[oldKey];
        Reflect.deleteProperty(components, oldKey);
      }
      const ports = { ...state.config.ports };
      if (ports[oldKey]) {
        ports[newKey] = ports[oldKey];
        Reflect.deleteProperty(ports, oldKey);
      }
      const nextSubStep = state.currentSubStep === oldKey ? newKey : state.currentSubStep;
      return resetReview({
        ...state,
        currentSubStep: nextSubStep,
        config: { ...state.config, components, ports },
      });
    }

    case "SET_PORTS":
      return resetReview({
        ...state,
        config: { ...state.config, ports: action.payload },
      });

    case "ADD_PORT": {
      const ports = {
        ...state.config.ports,
        [action.payload.key]: action.payload.port,
      };
      return resetReview({ ...state, config: { ...state.config, ports } });
    }

    case "REMOVE_PORT": {
      const ports = { ...state.config.ports };
      Reflect.deleteProperty(ports, action.payload);
      return resetReview({ ...state, config: { ...state.config, ports } });
    }

    case "UPDATE_PORT": {
      const ports = {
        ...state.config.ports,
        [action.payload.key]: action.payload.port,
      };
      return resetReview({ ...state, config: { ...state.config, ports } });
    }

    case "SET_TOOLS":
      return resetReview({
        ...state,
        config: { ...state.config, tools: action.payload },
      });

    case "SET_USERS": {
      if (action.payload.length === 0) {
        const next = { ...state.config };
        delete next.users;
        return resetReview({ ...state, config: next });
      }
      return resetReview({
        ...state,
        config: { ...state.config, users: action.payload },
      });
    }

    case "UPDATE_INSPECTION":
      return resetReview({
        ...state,
        config: { ...state.config, inspection: action.payload },
      });

    case "UPDATE_BENCHES":
      return resetReview({
        ...state,
        config: { ...state.config, benches: action.payload },
      });

    case "SET_SECTION":
      return { ...state, currentSection: action.payload, currentSubStep: null };

    case "SET_SECTION_AND_SUB_STEP":
      return {
        ...state,
        currentSection: action.payload.section,
        currentSubStep: action.payload.subStep,
      };

    case "SET_SUB_STEP":
      return { ...state, currentSubStep: action.payload };

    case "SET_SECTION_STATUS":
      if (state.sectionStatus[action.payload.section] === action.payload.status) return state;
      return {
        ...state,
        sectionStatus: {
          ...state.sectionStatus,
          [action.payload.section]: action.payload.status,
        },
      };

    case "SET_VALIDATION_ERRORS":
      return { ...state, validationErrors: action.payload };

    case "MERGE_VALIDATION_ERRORS":
      return {
        ...state,
        validationErrors: { ...state.validationErrors, ...action.payload },
      };

    case "MARK_TOUCHED":
      if (state.touched[action.payload]) return state;
      return {
        ...state,
        touched: { ...state.touched, [action.payload]: true },
      };

    case "SET_PORT_CONFLICTS":
      return { ...state, portConflicts: action.payload };

    case "APPLY_SCAN_RESULT": {
      const scan = action.payload;
      const config = { ...state.config };

      if (!config.project?.name && scan.detected.suggestedName) {
        config.project = {
          ...config.project,
          name: scan.detected.suggestedName,
          ...(!config.project?.displayName && {
            displayName: scan.detected.suggestedName,
          }),
        } as ProjectConfig;
      }
      if (!config.project?.repo && scan.detected.suggestedRepo) {
        config.project = {
          ...config.project,
          repo: scan.detected.suggestedRepo,
        } as ProjectConfig;
      }
      if (!config.project?.type && scan.detected.suggestedProjectType) {
        config.project = {
          ...config.project,
          type: scan.detected.suggestedProjectType,
        } as ProjectConfig;
      }
      if (!config.layout?.type) {
        config.layout = {
          ...config.layout,
          type: scan.detected.structureType,
        } as LayoutConfig;
        if (Object.keys(scan.detected.submodules).length > 0) {
          config.layout.submodules = scan.detected.submodules;
        }
      }

      // Auto-populate components and ports from scan suggestions
      if (!config.components || Object.keys(config.components).length === 0) {
        const suggested = scan.detected.suggestedComponents;
        if (suggested?.length) {
          const components: Record<string, ComponentConfig> = {};
          const ports: Record<string, PortConfig> = { ...config.ports };
          const benchesMax = config.benches?.max ?? 5;
          for (const s of suggested) {
            components[s.key] = s.config;
            const defaultPort = 3000;
            ports[s.key] = {
              base: nextAvailablePort(defaultPort, ports, benchesMax),
            };
          }
          config.components = components;
          if (Object.keys(ports).length > 0) config.ports = ports;
        }
      }

      // Auto-populate tools from scan suggestions
      if (!config.tools || config.tools.length === 0) {
        const suggestedTools = scan.detected.suggestedTools;
        if (suggestedTools?.length) {
          config.tools = suggestedTools.map((l) => l.config);
        }
      }

      if (scan.existingConfig) {
        return wizardReducer(
          { ...state, config, scanResult: scan },
          { type: "LOAD_EXISTING_CONFIG", payload: scan.existingConfig.config },
        );
      }

      return { ...state, config, scanResult: scan };
    }

    case "LOAD_EXISTING_CONFIG": {
      const sectionStatus = { ...state.sectionStatus };
      const sections = WIZARD_SECTIONS.filter((s) => s !== "review");
      for (const s of sections) {
        sectionStatus[s] = validateSection(s, action.payload) ?? "valid";
      }
      const hasInvalid = sections.some((s) => sectionStatus[s] === "invalid");
      sectionStatus.review = hasInvalid ? "invalid" : "valid";
      return {
        ...state,
        config: action.payload,
        sectionStatus,
        currentSubStep: null,
        isEditMode: true,
      };
    }

    default:
      return state;
  }
}

export function isWizardSaveDisabled(state: WizardState, isSaving: boolean): boolean {
  return (
    isSaving ||
    Object.keys(state.validationErrors).length > 0 ||
    (state.portConflicts?.length ?? 0) > 0
  );
}
