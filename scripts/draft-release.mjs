// Create a draft GitHub release for the latest code and dispatch the build.
//
// Computes the next patch/minor/major version from the latest published
// release, appends a "-rc.<short-sha>" pre-release identifier built from
// origin/main HEAD (SemVer item 9), creates the draft + pre-release with
// generated notes, then triggers the release.yml build workflow.
//
// Usage:
//   node scripts/draft-release.mjs <patch|minor|major> [--dry-run] [--no-dispatch]
//
// Requires an authenticated GitHub CLI (`gh auth status`).

import { execFileSync } from "node:child_process";

import { pickLatestPublishedTag, resolveNextTag } from "./release-version.mjs";

const USAGE =
  "Usage: node scripts/draft-release.mjs <patch|minor|major> [--dry-run] [--no-dispatch]";
const LEVELS = ["patch", "minor", "major"];

/** Run a command and return its trimmed stdout. Throws on non-zero exit. */
function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** Run a command for its exit status only, suppressing output. Returns true on success. */
function succeeds(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const level = argv.find((a) => !a.startsWith("-"));
  const dryRun = argv.includes("--dry-run");
  const noDispatch = argv.includes("--no-dispatch");

  if (!level || !LEVELS.includes(level)) {
    console.error(USAGE);
    process.exit(1);
  }

  // Preflight: gh auth and a git repo.
  if (!succeeds("gh", ["auth", "status"])) {
    fail("GitHub CLI is not authenticated. Run `gh auth login` first.");
  }
  if (!succeeds("git", ["rev-parse", "--git-dir"])) {
    fail("Not inside a git repository.");
  }

  // Always release the latest pushed code, independent of local checkout.
  console.log("Fetching origin/main ...");
  execFileSync("git", ["fetch", "origin", "main"], { stdio: "ignore" });
  const fullSha = capture("git", ["rev-parse", "origin/main"]);
  const shortSha = capture("git", ["rev-parse", "--short=7", "origin/main"]);

  // Resolve the base version from the latest published GitHub release.
  let releases;
  try {
    releases = JSON.parse(
      capture("gh", ["release", "list", "--json", "tagName,isLatest,isDraft,isPrerelease"]) || "[]",
    );
  } catch {
    fail("Could not parse `gh release list` output.");
  }
  const baseTag = pickLatestPublishedTag(releases);

  let tag;
  try {
    tag = resolveNextTag({ baseTag, level, shortSha });
  } catch (err) {
    fail(err.message);
  }

  // Guard against re-running on the same commit + bump level.
  if (succeeds("gh", ["release", "view", tag])) {
    fail(
      `A release already exists for tag ${tag}. origin/main has not advanced ` +
        `since the last ${level} draft for this commit. Push new commits or pick a different bump level.`,
    );
  }

  console.log("");
  console.log(`Base release:  ${baseTag ?? "(none, defaulting to v0.0.0)"}`);
  console.log(`Bump level:    ${level}`);
  console.log(`origin/main:   ${fullSha} (${shortSha})`);
  console.log(`New tag:       ${tag}`);
  console.log("");

  const createArgs = [
    "release",
    "create",
    tag,
    "--target",
    fullSha,
    "--title",
    tag,
    "--draft",
    "--prerelease",
    "--generate-notes",
  ];
  const dispatchArgs = ["workflow", "run", "release.yml", "-f", `tag_name=${tag}`];

  if (dryRun) {
    console.log("Dry run. No changes made. Would run:");
    console.log(`  gh ${createArgs.join(" ")}`);
    if (!noDispatch) {
      console.log(`  gh ${dispatchArgs.join(" ")}`);
    }
    process.exit(0);
  }

  console.log("Creating draft release ...");
  const releaseUrl = capture("gh", createArgs);
  console.log(`Draft release created: ${releaseUrl}`);

  if (noDispatch) {
    console.log("\n--no-dispatch set; skipping build workflow trigger.");
    console.log(`Trigger it later with: gh ${dispatchArgs.join(" ")}`);
  } else {
    console.log("Dispatching release build workflow ...");
    execFileSync("gh", dispatchArgs, { stdio: "inherit" });
    console.log("Build workflow dispatched. Watch it with: gh run list --workflow release.yml");
  }

  console.log("\nDone.");
  console.log(`  Tag:     ${tag}`);
  console.log(`  Release: ${releaseUrl}`);
}

main();
