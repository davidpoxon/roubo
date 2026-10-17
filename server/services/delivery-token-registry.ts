// The delivery token registry (SB-FR-003). A Spec Bench mints one
// delivery-scoped token each time it binds a session to its delivery: at
// launch, at resume, and at the attach handout (POST /delivery/attach). The
// plain token goes to the launched session in its launch descriptor, or in the
// handout's response body to its caller, and nowhere else; the bench keeps only
// its SHA-256 hash, as `deliveryTokenHash`, and persists that. A new mint replaces the hash, so
// the token of an earlier session stops working, and Clear bench revokes it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Bench } from "@roubo/shared";
import * as stateService from "./state.js";

const TOKEN_BYTES = 32;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function hashDeliveryToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function persist(bench: Bench): void {
  // updateBench replaces an existing record only, so a bench whose record is
  // not written yet gains none from here.
  stateService.updateBench(stateService.toPersistedBench(bench));
}

/** Mints a token for the bench, stores its hash on the bench, and returns the plain token. */
export function mintDeliveryToken(bench: Bench): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  bench.deliveryTokenHash = hashDeliveryToken(token);
  persist(bench);
  return token;
}

/** Whether a presented token is the bench's current one. */
export function verifyDeliveryToken(bench: Bench, token: string | undefined): boolean {
  const stored = bench.deliveryTokenHash;
  if (token === undefined || token.length === 0 || stored === undefined) return false;
  if (!HASH_PATTERN.test(stored)) return false;
  const presented = Buffer.from(hashDeliveryToken(token), "hex");
  return timingSafeEqual(presented, Buffer.from(stored, "hex"));
}

/**
 * Drops the bench's token. The caller persists the bench when it has to: Clear
 * bench writes the record itself once the variant's teardown is done.
 */
export function revokeDeliveryToken(bench: Bench): void {
  bench.deliveryTokenHash = undefined;
}
