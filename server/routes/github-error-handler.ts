import type { Response } from "express";
import { GitHubError, classifyGitHubError } from "../services/github-error.js";
import { ServiceError } from "../services/service-error.js";

export function sendGitHubErrorResponse(res: Response, err: unknown): void {
  if (err instanceof GitHubError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code, params: err.params });
    return;
  }

  const classified = classifyGitHubError(err);

  // Preserve the original status code for non-401 ServiceErrors (e.g. 400 for invalid params,
  // 404 for not-found) that classify as UNKNOWN since they aren't auth/permission failures.
  if (err instanceof ServiceError && classified.code === "UNKNOWN") {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  res.status(classified.statusCode).json({
    error: classified.message,
    code: classified.code,
    params: classified.params,
  });
}
