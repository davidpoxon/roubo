import fs from "node:fs";
import path from "node:path";
import type { IntegrationOverride, MigrationRecord } from "@roubo/shared";
import { getRouboDir, loadProjects, loadState, saveState } from "./state.js";
import { parseConfig } from "./config-parser.js";
import { saveOverride } from "./integration-overrides.js";
import { deleteCredentials } from "./github-auth.js";
import * as credentialStore from "./credential-store.js";

// WU-024 / issue #42 — pre-plugin → plugin migration. See:
//   .specifications/integration-plugins/prd.md (FR-027, FR-028, NFR-009)
//   .specifications/integration-plugins/test-cases.json (TC-031, TC-049, TC-068, TC-069)

const PLUGIN_ID = "github-com";
const CREDENTIAL_SLOT = "github-token";
const TARGET_SCHEMA_VERSION = 1;

export type MigrationOutcome =
  | { status: "noop" }
  | (MigrationRecord & { status: "success" | "rolled-back" });

interface AuthFile {
  githubToken: string;
}

interface ProjectPlan {
  projectId: string;
  githubProjectNumber: number | undefined;
}

let lastOutcome: MigrationOutcome | null = null;

export function getOutcome(): MigrationOutcome | null {
  return lastOutcome;
}

function authFilePath(): string {
  return path.join(getRouboDir(), "auth.json");
}

function readAuth(): AuthFile | null {
  const p = authFilePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as { githubToken?: unknown }).githubToken === "string" &&
      (raw as { githubToken: string }).githubToken.length > 0
    ) {
      return { githubToken: (raw as { githubToken: string }).githubToken };
    }
  } catch {
    // malformed auth.json — treat as missing
  }
  return null;
}

function overridePath(projectId: string): string {
  return path.join(getRouboDir(), "integrations", `${projectId}.yaml`);
}

export async function run(): Promise<MigrationOutcome> {
  const at = new Date().toISOString();
  const state = loadState();

  if ((state.schemaVersion ?? 0) >= TARGET_SCHEMA_VERSION) {
    const outcome: MigrationOutcome = { status: "noop" };
    lastOutcome = outcome;
    return outcome;
  }

  const auth = readAuth();
  const plans: ProjectPlan[] = [];
  for (const entry of loadProjects().projects) {
    const parsed = parseConfig(entry.repoPath);
    if (!parsed.valid || !parsed.config) {
      console.warn(
        `migrate: skipping project "${entry.id}" (roubo.yaml at ${entry.repoPath} failed to parse)`,
      );
      continue;
    }
    plans.push({
      projectId: entry.id,
      githubProjectNumber: parsed.config.project.github?.project,
    });
  }

  // Empty migration: bump the gate so we don't retry on every boot, but don't
  // surface a banner — nothing visible to the user has changed.
  if (!auth && plans.length === 0) {
    saveState({ ...state, schemaVersion: TARGET_SCHEMA_VERSION });
    const outcome: MigrationOutcome = { status: "noop" };
    lastOutcome = outcome;
    return outcome;
  }

  // Side-effects with reverse-order rollback. The schemaVersion bump below is
  // the single commit point — until it happens, every step here must be
  // individually undoable, and we must restore the original on-disk shape on
  // any failure.
  const rollback: Array<() => Promise<void> | void> = [];
  try {
    if (auth) {
      await credentialStore.set(PLUGIN_ID, CREDENTIAL_SLOT, auth.githubToken);
      rollback.push(() => credentialStore.deleteSlot(PLUGIN_ID, CREDENTIAL_SLOT));
    }
    for (const plan of plans) {
      const sources =
        plan.githubProjectNumber !== undefined
          ? { project: [String(plan.githubProjectNumber)] }
          : undefined;
      const override: IntegrationOverride = {
        schemaVersion: 1,
        integration: {
          plugin: PLUGIN_ID,
          ...(sources ? { sources } : {}),
        },
      };
      const filePath = overridePath(plan.projectId);
      saveOverride(plan.projectId, override);
      rollback.push(() => {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // best-effort
        }
      });
    }
  } catch (err) {
    for (let i = rollback.length - 1; i >= 0; i--) {
      try {
        await rollback[i]();
      } catch (rollbackErr) {
        console.warn(`migrate: rollback step ${i} failed:`, (rollbackErr as Error).message);
      }
    }
    const reason = (err as Error).message || String(err);
    const record: MigrationRecord = {
      status: "rolled-back",
      at,
      reason,
      migratedProjectIds: [],
    };
    // Persist the rolled-back marker WITHOUT bumping schemaVersion, so the
    // banner can render and the next boot can retry.
    saveState({ ...state, migration: record });
    const outcome: MigrationOutcome = { ...record };
    lastOutcome = outcome;
    return outcome;
  }

  // Commit: single state.json write bumps schemaVersion and records success.
  const record: MigrationRecord = {
    status: "success",
    at,
    migratedProjectIds: plans.map((p) => p.projectId),
  };
  saveState({ ...state, schemaVersion: TARGET_SCHEMA_VERSION, migration: record });

  // Post-commit cleanup. Best-effort: if this fails the migration has already
  // committed, so we log and move on rather than rolling back.
  if (auth) {
    try {
      deleteCredentials();
    } catch (err) {
      console.warn(
        "migrate: post-commit auth.json delete failed (state remains migrated):",
        (err as Error).message,
      );
    }
  }

  const outcome: MigrationOutcome = { ...record };
  lastOutcome = outcome;
  return outcome;
}

// Test-only reset so vitest's module-mock isolation can clear lastOutcome.
export const __test = {
  reset(): void {
    lastOutcome = null;
  },
};
