import { Router } from "express";
import { loadState } from "../services/state.js";

const router = Router();

// Surfaces the post-boot migration record (WU-024 / issue #42) so the client
// can render the one-time banner.
router.get("/status", (_req, res) => {
  const state = loadState();
  res.json({
    schemaVersion: state.schemaVersion ?? null,
    migration: state.migration ?? null,
  });
});

export default router;
