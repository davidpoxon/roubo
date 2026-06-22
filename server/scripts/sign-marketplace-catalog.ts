#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  canonicalPayloadBytes,
  CATALOG_PUBLIC_KEY_PEM,
} from "../services/marketplace-integrity.js";

// Maintainer-only signing step for the marketplace catalog (CP-FR-021, issue
// #622). After editing server/services/marketplace-catalog.json (adding an
// entry, bumping a version, revoking a plugin, or updating an integrity digest),
// re-sign the payload so the server's load-time signature check passes again.
//
// Usage:
//   ROUBO_CATALOG_PRIVATE_KEY=/path/to/ed25519-priv.pem \
//     npx tsx server/scripts/sign-marketplace-catalog.ts
//
// The private key (ed25519, PKCS8 PEM) is held out of band and is never
// committed. The matching public key is bundled in marketplace-integrity.ts;
// this script verifies the produced signature against it before writing, so a
// key mismatch fails loudly rather than committing an unverifiable catalog.

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.resolve(here, "..", "services", "marketplace-catalog.json");

async function main(): Promise<void> {
  const keyPath = process.env.ROUBO_CATALOG_PRIVATE_KEY;
  if (!keyPath) {
    throw new Error("Set ROUBO_CATALOG_PRIVATE_KEY to the ed25519 private-key PEM path.");
  }
  const privateKey = createPrivateKey(await readFile(keyPath, "utf8"));

  const raw = JSON.parse(await readFile(catalogPath, "utf8")) as {
    $comment?: string;
    payload: { entries: unknown[] };
    signature?: string;
  };

  const bytes = canonicalPayloadBytes(raw.payload);
  const signature = sign(null, bytes, privateKey).toString("base64");

  // Sanity-check against the bundled public key before writing.
  const ok = verify(
    null,
    bytes,
    createPublicKey(CATALOG_PUBLIC_KEY_PEM),
    Buffer.from(signature, "base64"),
  );
  if (!ok) {
    throw new Error(
      "Produced signature does not verify against the bundled public key. The private key does not match CATALOG_PUBLIC_KEY_PEM.",
    );
  }

  raw.signature = signature;
  await writeFile(catalogPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  process.stdout.write(`Signed ${catalogPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
});
