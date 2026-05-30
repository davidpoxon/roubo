import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { makeDirent } from "../test/fixtures.js";

vi.mock("node:fs/promises");
vi.mock("node:os", () => ({ homedir: () => "/mock-home" }));

import { readdir, access } from "node:fs/promises";

async function loadRouter(): Promise<express.Router> {
  vi.resetModules();
  const mod = await import("./filesystem.js");
  return mod.default;
}

async function makeApp(): Promise<express.Express> {
  const router = await loadRouter();
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
}

const originalEnv = process.env.ROUBO_FILESYSTEM_ROOTS;

beforeEach(() => {
  delete process.env.ROUBO_FILESYSTEM_ROOTS;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.ROUBO_FILESYSTEM_ROOTS;
  } else {
    process.env.ROUBO_FILESYSTEM_ROOTS = originalEnv;
  }
});

describe("GET /", () => {
  it("defaults to home directory", async () => {
    vi.mocked(readdir).mockResolvedValue([makeDirent("projects", false)]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const app = await makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/mock-home");
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].name).toBe("projects");
  });

  it("reads a directory inside the home root", async () => {
    vi.mocked(readdir).mockResolvedValue([makeDirent("src", false)]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const app = await makeApp();
    const res = await request(app).get("/?path=/mock-home/some/dir");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/mock-home/some/dir");
  });

  it("rejects directories outside the home root with 403", async () => {
    vi.mocked(readdir).mockResolvedValue([makeDirent("src", false)]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const app = await makeApp();
    const res = await request(app).get("/?path=/etc");
    expect(res.status).toBe(403);
  });

  it("rejects traversal that escapes the home root with 403", async () => {
    vi.mocked(readdir).mockResolvedValue([makeDirent("src", false)]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const app = await makeApp();
    const res = await request(app).get("/?path=/mock-home/../etc");
    expect(res.status).toBe(403);
  });

  it("accepts paths inside ROUBO_FILESYSTEM_ROOTS allowlist", async () => {
    process.env.ROUBO_FILESYSTEM_ROOTS = "/opt/repos";
    vi.mocked(readdir).mockResolvedValue([makeDirent("src", false)]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const app = await makeApp();
    const res = await request(app).get("/?path=/opt/repos/proj");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/opt/repos/proj");
  });

  it("rejects path containing a null byte with 400", async () => {
    const app = await makeApp();
    const res = await request(app).get("/?path=%2Fmock-home%2F%00bad");
    expect(res.status).toBe(400);
  });

  it("filters hidden directories unless showHidden=true", async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent(".hidden", false),
      makeDirent("visible", false),
    ]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const app = await makeApp();
    const resHidden = await request(app).get("/?path=/mock-home/dir");
    expect(resHidden.body.entries).toHaveLength(1);
    expect(resHidden.body.entries[0].name).toBe("visible");

    const resShown = await request(app).get("/?path=/mock-home/dir&showHidden=true");
    expect(resShown.body.entries).toHaveLength(2);
  });

  it("sets hasGit for directories with .git", async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent("with-git", false),
      makeDirent("without-git", false),
    ]);
    vi.mocked(access).mockImplementation((p: unknown) => {
      if (String(p).includes("with-git")) return Promise.resolve();
      return Promise.reject(new Error("no .git"));
    });

    const app = await makeApp();
    const res = await request(app).get("/?path=/mock-home/dir");
    expect(res.status).toBe(200);
    const withGit = res.body.entries.find((e: { name: string }) => e.name === "with-git");
    const withoutGit = res.body.entries.find((e: { name: string }) => e.name === "without-git");
    expect(withGit.hasGit).toBe(true);
    expect(withoutGit.hasGit).toBe(false);
  });

  it("sorts git dirs first, then alphabetical", async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent("zebra", false),
      makeDirent("alpha-git", false),
      makeDirent("beta", false),
    ]);
    vi.mocked(access).mockImplementation((p: unknown) => {
      if (String(p).includes("alpha-git")) return Promise.resolve();
      return Promise.reject(new Error("no .git"));
    });

    const app = await makeApp();
    const res = await request(app).get("/?path=/mock-home/dir");
    expect(res.status).toBe(200);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(["alpha-git", "beta", "zebra"]);
  });

  it("returns 404 for ENOENT", async () => {
    const err = new Error("Not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.mocked(readdir).mockRejectedValue(err);

    const app = await makeApp();
    const res = await request(app).get("/?path=/mock-home/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 403 for EACCES", async () => {
    const err = new Error("Permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    vi.mocked(readdir).mockRejectedValue(err);

    const app = await makeApp();
    const res = await request(app).get("/?path=/mock-home/forbidden");
    expect(res.status).toBe(403);
  });

  it("returns 400 for ENOTDIR", async () => {
    const err = new Error("Not a directory") as NodeJS.ErrnoException;
    err.code = "ENOTDIR";
    vi.mocked(readdir).mockRejectedValue(err);

    const app = await makeApp();
    const res = await request(app).get("/?path=/mock-home/some/file.txt");
    expect(res.status).toBe(400);
  });
});
