import { copyResources } from "../dist/packaging/copy-resources.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const electronRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(electronRoot);

console.log("[roubo] copying build outputs into electron/resources/ ...");
await copyResources({ repoRoot, electronRoot });
console.log("[roubo] resources ready.");
