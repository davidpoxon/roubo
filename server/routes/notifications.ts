import { Router } from "express";
import * as sseService from "../services/sse.js";

const router = Router();

router.get("/stream", (_req, res) => {
  sseService.addClient(res);
});

export default router;
