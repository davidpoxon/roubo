import type { Response } from "express";
import * as jigManager from "../services/jig-manager.js";

export class RouteError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseIntParam(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n)) throw new RouteError(400, `Invalid ${name}`);
  return n;
}

export const VALID_JIG_ID = /^[a-z0-9_-]+$/;

export function handleJigError(res: Response, err: unknown): void {
  if (err instanceof jigManager.JigError) {
    if (err.code === "REFERENCED") {
      res.status(409).json({ error: err.message, code: "JIG_REFERENCED", references: err.data });
      return;
    }
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      RESERVED_ID: 400,
      INVALID_NAME: 400,
      INVALID_DESCRIPTION: 400,
      INVALID_ICON: 400,
      INVALID_CONTENT: 400,
      DUPLICATE_ID: 409,
      DUPLICATE_NAME: 409,
    };
    const status = statusMap[err.code] ?? 500;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
}
