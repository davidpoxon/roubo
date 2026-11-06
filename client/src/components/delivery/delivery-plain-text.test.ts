// Session text reaches the Delivery tab only as React text nodes (SB-NFR-009):
// no file of the delivery feature folder sets inner HTML.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The jsdom URL global is not the one fileURLToPath takes, so the folder is
// taken from this file's own path.
const FOLDER = path.dirname(fileURLToPath(import.meta.url));
// Spelled in two parts, so this file does not name the prop it looks for.
const INNER_HTML_PROP = ["dangerously", "SetInnerHTML"].join("");

describe("delivery feature folder", () => {
  it("SB-TC-083: no file sets inner HTML from session text", () => {
    const files = fs
      .readdirSync(FOLDER, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|tsx)$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) =>
      fs.readFileSync(path.join(FOLDER, file), "utf8").includes(INNER_HTML_PROP),
    );
    expect(offenders).toEqual([]);
  });
});
