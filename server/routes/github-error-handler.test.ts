import { describe, it, expect, vi } from "vitest";
import { sendGitHubErrorResponse } from "./github-error-handler.js";
import { GitHubError } from "../services/github-error.js";
import { ServiceError } from "../services/service-error.js";

function makeRes() {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json, _status: status, _json: json } as unknown as import("express").Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe("sendGitHubErrorResponse", () => {
  it("passes through a GitHubError directly", () => {
    const res = makeRes();
    const err = new GitHubError("NOT_CONNECTED", "not connected", 401);
    sendGitHubErrorResponse(res, err);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_CONNECTED" }));
  });

  it("includes params in response for GitHubError with params", () => {
    const res = makeRes();
    const err = new GitHubError("ORG_APPROVAL_REQUIRED", "needs approval", 403, { owner: "acme" });
    sendGitHubErrorResponse(res, err);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ params: { owner: "acme" }, code: "ORG_APPROVAL_REQUIRED" }),
    );
  });

  it("classifies a plain Error and sends structured response", () => {
    const res = makeRes();
    sendGitHubErrorResponse(res, new Error("bad credentials"));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_CONNECTED" }));
  });

  it("preserves ServiceError status for non-auth UNKNOWN errors", () => {
    const res = makeRes();
    const err = new ServiceError(400, "invalid request param");
    sendGitHubErrorResponse(res, err);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid request param" }),
    );
  });

  it("uses classified status for 401 ServiceError (NOT_CONNECTED)", () => {
    const res = makeRes();
    const err = new ServiceError(
      401,
      "GitHub is not connected. Connect your GitHub account in Settings.",
    );
    sendGitHubErrorResponse(res, err);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_CONNECTED" }));
  });
});
