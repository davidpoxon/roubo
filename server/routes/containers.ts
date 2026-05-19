import { Router } from "express";
import * as dockerService from "../services/docker.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const containers = await dockerService.listDatabaseContainers();
    res.json(containers);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
