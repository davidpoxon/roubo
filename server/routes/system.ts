import { Router } from "express";
import { getLoginShellImportStatus } from "../services/env.js";
import type { SystemStatusResponse } from "@roubo/shared";

const router = Router();

/**
 * Server-level conditions fixed at boot that the operator should see in the
 * app, not only in the log (#1487). Each one is settled before the server
 * listens, so a client can read them once.
 */
router.get("/status", (_req, res) => {
  const body: SystemStatusResponse = { loginShellImport: getLoginShellImportStatus() };
  res.json(body);
});

export default router;
