import { Router } from "express";
import rateLimit from "express-rate-limit";
import { readdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { DirectoryEntry, BrowseDirectoryResponse } from "@roubo/shared";
import { resolveWithin, resolveWithinRoots, allowedRoots } from "../lib/safe-path.js";

const router = Router();

// Defence-in-depth rate limit on the directory-browse surface. Roubo runs as a
// localhost-only service, but this handler takes a user-supplied path and touches
// it from disk (readdir + per-entry access), so we cap requests per minute per IP
// to keep a runaway caller from hammering the filesystem. Applied router-wide
// because this router has a single route mounted on its own /api/filesystem/browse
// prefix. Mirrors the pattern in plugins-github-oauth.ts and satisfies CodeQL
// js/missing-rate-limiting (#38).
const browseRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.use(browseRateLimiter);

const MAX_PATH_LENGTH = 4096;

router.get("/", async (req, res) => {
  const rawPath = (req.query.path as string) || homedir();
  const showHidden = req.query.showHidden === "true";

  if (typeof rawPath !== "string" || rawPath.includes("\0") || rawPath.length > MAX_PATH_LENGTH) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  const resolved = resolveWithinRoots(allowedRoots(), rawPath);
  if (resolved === null) {
    res.status(403).json({ error: `Path is outside the allowed roots: ${path.resolve(rawPath)}` });
    return;
  }

  let dirents;
  try {
    dirents = await readdir(resolved, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      res.status(404).json({ error: `Directory not found: ${resolved}` });
    } else if (code === "EACCES") {
      res.status(403).json({ error: `Permission denied: ${resolved}` });
    } else if (code === "ENOTDIR") {
      res.status(400).json({ error: `Not a directory: ${resolved}` });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
    return;
  }

  const dirs = dirents.filter((d) => {
    if (!d.isDirectory()) return false;
    if (!showHidden && d.name.startsWith(".")) return false;
    return true;
  });

  const entries: DirectoryEntry[] = await Promise.all(
    dirs.map(async (d) => {
      let fullPath: string;
      try {
        fullPath = resolveWithin(resolved, d.name);
      } catch {
        return { name: d.name, path: path.join(resolved, d.name), hasGit: false };
      }
      let hasGit = false;
      try {
        await access(resolveWithin(fullPath, ".git"));
        hasGit = true;
      } catch {
        // no .git
      }
      return { name: d.name, path: fullPath, hasGit };
    }),
  );

  entries.sort((a, b) => {
    if (a.hasGit !== b.hasGit) return a.hasGit ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const body: BrowseDirectoryResponse = { path: resolved, entries };
  res.json(body);
});

export default router;
