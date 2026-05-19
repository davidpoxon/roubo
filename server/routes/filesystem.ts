import { Router } from "express";
import { readdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { DirectoryEntry, BrowseDirectoryResponse } from "@roubo/shared";

const router = Router();

router.get("/", async (req, res) => {
  const rawPath = (req.query.path as string) || homedir();
  const showHidden = req.query.showHidden === "true";
  const resolved = path.resolve(rawPath);

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
      const fullPath = path.join(resolved, d.name);
      let hasGit = false;
      try {
        await access(path.join(fullPath, ".git"));
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
