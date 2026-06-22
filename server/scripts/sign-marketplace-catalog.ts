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
// Usage (the ed25519 PKCS8 PEM private key is piped in on stdin, never passed as
// a filesystem path, so no external value reaches a filesystem read):
//   npx tsx server/scripts/sign-marketplace-catalog.ts < /path/to/ed25519-priv.pem
//   # equivalently: cat /path/to/ed25519-priv.pem | npx tsx server/scripts/sign-marketplace-catalog.ts
//
// The private key is held out of band and is never committed. The matching
// public key is bundled in marketplace-integrity.ts; this script verifies the
// produced signature against it before writing, so a key mismatch fails loudly
// rather than committing an unverifiable catalog. Reading the key from stdin
// (rather than from an environment-supplied path) keeps any external value out
// of a filesystem read sink.

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.resolve(here, "..", "services", "marketplace-catalog.json");

/** Read the private-key PEM from stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const pem = (await readStdin()).trim();
  if (!pem) {
    throw new Error(
      "No private key on stdin. Pipe the ed25519 PKCS8 PEM in, e.g. `npx tsx server/scripts/sign-marketplace-catalog.ts < ed25519-priv.pem`.",
    );
  }
  const privateKey = createPrivateKey(pem);

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
