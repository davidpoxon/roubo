// The evidence of a case mark (SB-FR-027): a note and a screenshot that the
// case status route takes beside the override. The screenshot is written as a
// file under the spec folder that holds test-results.json, in
// `evidence/<caseId>/`, and the note, with the file's path relative to the spec
// folder, is appended to the case's notes in test-results.json. The results
// schema does not change.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SPEC_SLUG_RE,
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
} from "./safe-path.js";

/** The folder of the spec folder that holds the evidence files, one folder per case. */
export const CASE_EVIDENCE_DIR = "evidence";

/** The largest screenshot the route takes, decoded. */
export const CASE_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** The body limit of the case status route: a screenshot at its largest, base64-encoded, with room. */
export const CASE_STATUS_BODY_LIMIT = "6mb";

// A case id names a folder, so it is one plain path segment.
const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SCREENSHOT_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

const SCREENSHOT_EXTENSIONS: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" };

/** Evidence the route cannot take: the route answers 400 with its message. */
export class InvalidEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvidenceError";
  }
}

/** A screenshot decoded from its data URL. */
export interface CaseScreenshot {
  extension: string;
  bytes: Buffer;
}

/**
 * Decodes a screenshot sent as a `data:image/<png|jpeg|webp>;base64,...` URL.
 * Throws InvalidEvidenceError for any other form, an empty image, or one over
 * CASE_SCREENSHOT_MAX_BYTES.
 */
export function decodeCaseScreenshot(dataUrl: string): CaseScreenshot {
  const match = SCREENSHOT_DATA_URL_RE.exec(dataUrl);
  if (match === null) {
    throw new InvalidEvidenceError(
      "evidence.screenshot must be a base64 data URL of a PNG, JPEG or WebP image",
    );
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) {
    throw new InvalidEvidenceError("evidence.screenshot holds no image");
  }
  if (bytes.length > CASE_SCREENSHOT_MAX_BYTES) {
    throw new InvalidEvidenceError(
      `evidence.screenshot is over the ${CASE_SCREENSHOT_MAX_BYTES / (1024 * 1024)} MB limit`,
    );
  }
  return { extension: SCREENSHOT_EXTENSIONS[match[1]], bytes };
}

/**
 * Writes a case's screenshot under `<rootPath>/.specifications/<slug>/evidence/<caseId>/`
 * and returns its path relative to the spec folder, with forward slashes.
 */
export function writeCaseScreenshot(
  rootPath: string,
  slug: string,
  caseId: string,
  screenshot: CaseScreenshot,
  now: Date = new Date(),
): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  assertSafeIdentifier(caseId, CASE_ID_RE, "case id");
  const specDir = resolveWithin(rootPath, ".specifications", slug);
  const dir = resolveWithin(specDir, CASE_EVIDENCE_DIR, caseId);
  // Checked before the mkdir, which would follow a symlinked folder out of the root.
  assertRealpathWithin(rootPath, dir, "evidence dir");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${randomUUID().slice(0, 8)}.${screenshot.extension}`;
  fs.writeFileSync(path.join(dir, name), screenshot.bytes, { flag: "wx" });
  return [CASE_EVIDENCE_DIR, caseId, name].join("/");
}

/** The note appended to the case's notes: the evidence note, then the screenshot's path. */
export function caseEvidenceNoteText(
  note: string | undefined,
  screenshotPath: string | undefined,
): string {
  const lines: string[] = [];
  const text = note?.trim() ?? "";
  if (text.length > 0) lines.push(text);
  if (screenshotPath !== undefined) lines.push(`Screenshot: ${screenshotPath}`);
  return lines.join("\n");
}
