import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { makeDirent } from "../test/fixtures.js";

vi.mock("node:fs/promises");
vi.mock("node:os", () => ({ homedir: () => "/mock-home" }));

import router from "./filesystem.js";
import { readdir, access } from "node:fs/promises";

const app = express();
app.use(express.json());
app.use("/", router);

describe("GET /", () => {
  it("defaults to home directory", async () => {
    vi.mocked(readdir).mockResolvedValue([makeDirent("projects", false)]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/mock-home");
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].name).toBe("projects");
  });

  it("reads specified directory", async () => {
    vi.mocked(readdir).mockResolvedValue([makeDirent("src", false)]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const res = await request(app).get("/?path=/some/dir");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/some/dir");
  });

  it("filters hidden directories unless showHidden=true", async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent(".hidden", false),
      makeDirent("visible", false),
    ]);
    vi.mocked(access).mockRejectedValue(new Error("no .git"));

    const resHidden = await request(app).get("/?path=/dir");
    expect(resHidden.body.entries).toHaveLength(1);
    expect(resHidden.body.entries[0].name).toBe("visible");

    const resShown = await request(app).get("/?path=/dir&showHidden=true");
    expect(resShown.body.entries).toHaveLength(2);
  });

  it("sets hasGit for directories with .git", async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent("with-git", false),
      makeDirent("without-git", false),
    ]);
    vi.mocked(access).mockImplementation((p: any) => {
      if (String(p).includes("with-git")) return Promise.resolve();
      return Promise.reject(new Error("no .git"));
    });

    const res = await request(app).get("/?path=/dir");
    expect(res.status).toBe(200);
    const withGit = res.body.entries.find((e: any) => e.name === "with-git");
    const withoutGit = res.body.entries.find((e: any) => e.name === "without-git");
    expect(withGit.hasGit).toBe(true);
    expect(withoutGit.hasGit).toBe(false);
  });

  it("sorts git dirs first, then alphabetical", async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent("zebra", false),
      makeDirent("alpha-git", false),
      makeDirent("beta", false),
    ]);
    vi.mocked(access).mockImplementation((p: any) => {
      if (String(p).includes("alpha-git")) return Promise.resolve();
      return Promise.reject(new Error("no .git"));
    });

    const res = await request(app).get("/?path=/dir");
    expect(res.status).toBe(200);
    const names = res.body.entries.map((e: any) => e.name);
    expect(names).toEqual(["alpha-git", "beta", "zebra"]);
  });

  it("returns 404 for ENOENT", async () => {
    const err = new Error("Not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.mocked(readdir).mockRejectedValue(err);

    const res = await request(app).get("/?path=/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 403 for EACCES", async () => {
    const err = new Error("Permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    vi.mocked(readdir).mockRejectedValue(err);

    const res = await request(app).get("/?path=/forbidden");
    expect(res.status).toBe(403);
  });

  it("returns 400 for ENOTDIR", async () => {
    const err = new Error("Not a directory") as NodeJS.ErrnoException;
    err.code = "ENOTDIR";
    vi.mocked(readdir).mockRejectedValue(err);

    const res = await request(app).get("/?path=/some/file.txt");
    expect(res.status).toBe(400);
  });
});
