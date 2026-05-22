import { runCommand } from "./exec.js";

const SERVICE = "roubo-plugins";

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

async function macosSet(account: string, value: string): Promise<void> {
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
  const result = await runCommand(
    "security",
    ["delete-generic-password", "-a", account, "-s", SERVICE],
    process.cwd(),
  );
  if (result.code === 0 || result.code === 44 || /could not be found/i.test(result.stderr)) {
    return;
  }
  throw new CredentialStoreError(
    "keyring-delete-failed",
    `macOS keyring delete failed (exit ${result.code}): ${result.stderr.trim() || "unknown error"}`,
  );
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
  if (result.code === 0 || result.code === 1) return;
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
  return platform === "darwin" ? macosSet(account, value) : linuxSet(account, value);
}

export async function deleteSlot(pluginId: string, slot: string): Promise<void> {
  const platform = requireSupportedPlatform();
  const account = storageAccount(pluginId, slot);
  return platform === "darwin" ? macosDelete(account) : linuxDelete(account);
}
