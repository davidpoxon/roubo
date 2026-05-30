import { runCommand } from "./exec.js";

const SERVICE = "roubo-plugins";

// Upper bound on how many duplicate keychain items we will purge in one pass.
// macOS `delete-generic-password` removes one matching item per call, so a
// keychain that accumulated duplicates across prior connections needs a loop.
// Real keychains hold at most a handful of duplicates; this bound only guards
// against an unexpected non-terminating loop (e.g. a `security` build that keeps
// reporting exit 0 without actually deleting).
const MAX_KEYCHAIN_PURGE_ITERATIONS = 64;

export class CredentialStoreError extends Error {
  constructor(
    public code:
      | "unsupported-platform"
      | "keyring-unavailable"
      | "keyring-read-failed"
      | "keyring-write-failed"
      | "keyring-delete-failed",
    message: string,
  ) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

function storageAccount(pluginId: string, slot: string): string {
  return `${pluginId}/${slot}`;
}

function requireSupportedPlatform(): "darwin" | "linux" {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  throw new CredentialStoreError(
    "unsupported-platform",
    `Credential store is not supported on platform "${process.platform}" (macOS and Linux only)`,
  );
}

async function macosGet(account: string): Promise<string | null> {
  const result = await runCommand(
    "security",
    ["find-generic-password", "-a", account, "-s", SERVICE, "-w"],
    process.cwd(),
  );
  if (result.code === 0) {
    return result.stdout.replace(/\n$/, "");
  }
  if (result.code === 44 || /could not be found/i.test(result.stderr)) {
    return null;
  }
  throw new CredentialStoreError(
    "keyring-read-failed",
    `macOS keyring read failed (exit ${result.code}): ${result.stderr.trim() || "unknown error"}`,
  );
}

// Remove every keychain item matching this account, not just the first.
// `find-generic-password` returns the first match in the keychain search list,
// while `add-generic-password -U` updates only one item, so a stale duplicate
// left over from a prior connection can be the one read back later. Looping the
// delete until "not found" guarantees a clean slate before we write (and is the
// whole of `macosDelete`). Returns the number of items removed.
async function macosPurge(account: string): Promise<number> {
  let removed = 0;
  for (let i = 0; i < MAX_KEYCHAIN_PURGE_ITERATIONS; i++) {
    const result = await runCommand(
      "security",
      ["delete-generic-password", "-a", account, "-s", SERVICE],
      process.cwd(),
    );
    if (result.code === 0) {
      removed += 1;
      continue;
    }
    if (result.code === 44 || /could not be found/i.test(result.stderr)) {
      return removed;
    }
    throw new CredentialStoreError(
      "keyring-delete-failed",
      `macOS keyring delete failed (exit ${result.code}): ${result.stderr.trim() || "unknown error"}`,
    );
  }
  return removed;
}

async function macosSet(account: string, value: string): Promise<void> {
  // Purge any pre-existing items first so exactly one item carries the new
  // value. Without this, `add -U` updates one copy while a stale duplicate
  // survives and `find` may return the stale one (TC: reconnect after a prior
  // connection on the same machine surfaced "Bad credentials").
  await macosPurge(account);
  const result = await runCommand(
    "security",
    ["add-generic-password", "-a", account, "-s", SERVICE, "-w", value, "-U"],
    process.cwd(),
  );
  if (result.code !== 0) {
    throw new CredentialStoreError(
      "keyring-write-failed",
      `macOS keyring write failed (exit ${result.code}): ${result.stderr.trim() || "unknown error"}`,
    );
  }
}

async function macosDelete(account: string): Promise<void> {
  await macosPurge(account);
}

function detectLinuxKeyringFailure(stderr: string): boolean {
  return (
    /cannot autolaunch d-?bus/i.test(stderr) ||
    /no such interface/i.test(stderr) ||
    /no.*secret service/i.test(stderr) ||
    /unable to connect/i.test(stderr)
  );
}

async function linuxGet(account: string): Promise<string | null> {
  const result = await runCommand(
    "secret-tool",
    ["lookup", "service", SERVICE, "account", account],
    process.cwd(),
  );
  if (result.code === 0) {
    if (result.stdout.length === 0) return null;
    return result.stdout.replace(/\n$/, "");
  }
  if (result.code === 1 && result.stderr.length === 0) {
    return null;
  }
  if (detectLinuxKeyringFailure(result.stderr)) {
    throw new CredentialStoreError(
      "keyring-unavailable",
      `Linux keyring unavailable: ${result.stderr.trim()}. See credential-store.README.md for the headless Ubuntu recipe.`,
    );
  }
  throw new CredentialStoreError(
    "keyring-read-failed",
    `Linux keyring read failed (exit ${result.code}): ${result.stderr.trim() || "unknown error"}`,
  );
}

async function linuxSet(account: string, value: string): Promise<void> {
  const label = `roubo-${account.replace("/", "-")}`;
  const result = await runCommand(
    "secret-tool",
    ["store", "--label", label, "service", SERVICE, "account", account],
    process.cwd(),
    undefined,
    undefined,
    value,
  );
  if (result.code === 0) return;
  if (detectLinuxKeyringFailure(result.stderr)) {
    throw new CredentialStoreError(
      "keyring-unavailable",
      `Linux keyring unavailable: ${result.stderr.trim()}. See credential-store.README.md for the headless Ubuntu recipe.`,
    );
  }
  throw new CredentialStoreError(
    "keyring-write-failed",
    `Linux keyring write failed (exit ${result.code}): ${result.stderr.trim() || "unknown error"}`,
  );
}

async function linuxDelete(account: string): Promise<void> {
  const result = await runCommand(
    "secret-tool",
    ["clear", "service", SERVICE, "account", account],
    process.cwd(),
  );
  if (result.code === 0) return;
  if (result.code === 1 && result.stderr.length === 0) return;
  if (detectLinuxKeyringFailure(result.stderr)) {
    throw new CredentialStoreError(
      "keyring-unavailable",
      `Linux keyring unavailable: ${result.stderr.trim()}. See credential-store.README.md for the headless Ubuntu recipe.`,
    );
  }
  throw new CredentialStoreError(
    "keyring-delete-failed",
    `Linux keyring delete failed (exit ${result.code}): ${result.stderr.trim() || "unknown error"}`,
  );
}

export async function get(pluginId: string, slot: string): Promise<string | null> {
  const platform = requireSupportedPlatform();
  const account = storageAccount(pluginId, slot);
  return platform === "darwin" ? macosGet(account) : linuxGet(account);
}

export async function set(pluginId: string, slot: string, value: string): Promise<void> {
  const platform = requireSupportedPlatform();
  const account = storageAccount(pluginId, slot);
  if (platform === "darwin") {
    await macosSet(account, value);
  } else {
    await linuxSet(account, value);
  }
  // Verify-after-write: read the value straight back and confirm the keyring
  // returns exactly what we wrote. This turns a silent stale-write (e.g. a
  // macOS keychain handing back an older duplicate) into a loud, specific
  // error at write time, rather than an opaque downstream "Bad credentials".
  const readback = platform === "darwin" ? await macosGet(account) : await linuxGet(account);
  if (readback !== value) {
    throw new CredentialStoreError(
      "keyring-write-failed",
      `keyring write verification failed for "${account}": wrote ${value.length} bytes, ` +
        `read back ${readback === null ? "null" : `${readback.length} bytes`}`,
    );
  }
}

export async function deleteSlot(pluginId: string, slot: string): Promise<void> {
  const platform = requireSupportedPlatform();
  const account = storageAccount(pluginId, slot);
  return platform === "darwin" ? macosDelete(account) : linuxDelete(account);
}
