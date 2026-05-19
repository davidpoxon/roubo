import { Router } from "express";
import * as benchManager from "../services/bench-manager.js";
import { BenchError } from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as databaseService from "../services/database.js";
import {
  buildTemplateContext,
  resolveTemplate,
  applyContainerOverrides,
} from "../services/config-parser.js";
import { RouteError, parseIntParam } from "./helpers.js";

const router = Router();

function handleBenchError(res: import("express").Response, err: unknown) {
  if (err instanceof RouteError) {
    res.status(err.statusCode).json({ error: err.message });
  } else if (err instanceof BenchError) {
    const status = ["NOT_FOUND", "PROJECT_NOT_FOUND", "CONTAINER_NOT_FOUND"].includes(err.code)
      ? 404
      : 400;
    res.status(status).json({ error: err.message, code: err.code });
  } else {
    res.status(500).json({ error: (err as Error).message });
  }
}

function resolveConnectionString(projectId: string, benchId: number): string {
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) throw new BenchError("Bench not found", "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError("Project config not found", "PROJECT_NOT_FOUND");

  const dbEntry = Object.entries(project.config.components).find(
    ([, component]) => component.type === "database" && component.connection?.template,
  );
  if (!dbEntry) throw new BenchError("No database component configured", "NO_DATABASE");

  const ctx = buildTemplateContext(project.config, benchId, bench.workspacePath);
  applyContainerOverrides(ctx, bench.assignedContainers);

  const connectionTemplate = dbEntry[1].connection?.template;
  if (!connectionTemplate) throw new BenchError("No database connection template", "NO_DATABASE");
  return resolveTemplate(connectionTemplate, ctx);
}

router.get("/:projectId/benches/:id/database/tables", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const connectionString = resolveConnectionString(req.params.projectId, benchId);
    const tables = await databaseService.getTables(connectionString);
    res.json(tables);
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.get("/:projectId/benches/:id/database/tables/:table/data", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize as string, 10) || 50), 500);
    const schema = (req.query.schema as string) || "dbo";
    const connectionString = resolveConnectionString(req.params.projectId, benchId);
    const data = await databaseService.getTableData(
      connectionString,
      schema,
      req.params.table,
      page,
      pageSize,
    );
    res.json(data);
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.get("/:projectId/benches/:id/database/tables/:table/schema", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const schema = (req.query.schema as string) || "dbo";
    const connectionString = resolveConnectionString(req.params.projectId, benchId);
    const tableSchema = await databaseService.getTableSchema(
      connectionString,
      schema,
      req.params.table,
    );
    res.json(tableSchema);
  } catch (err) {
    handleBenchError(res, err);
  }
});

export default router;
