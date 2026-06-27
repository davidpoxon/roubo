#!/usr/bin/env python3
"""migrate_issues_to_work_units.py: convert a legacy issues.json into the
work-units.json envelope (WUAAVG-FR-016).

Stdlib only. The legacy format is a bare JSON array of issue entries (or a
wrapper object carrying the list under `issues` / `entries`). This one-shot,
additive, idempotent migration reads that legacy file and writes a sibling
`work-units.json` envelope ({$schema, schemaVersion:"1.0.0", specSlug, units})
through `work_units.write_envelope`, which is atomic, refuses any target outside
the spec folder, and NEVER deletes or overwrites issues.json (legacy removal is
the separate shim-drop step, WUAAVG-NFR-001).

It is **additive**: issues.json is read, never mutated. It is **idempotent**: ids
are minted deterministically (WU-NNN in input order) and a real run that would
produce a byte-identical work-units.json short-circuits as a no-op.

Per-unit field mapping (the core transform):

    id              <- minted WU-{i:03d} in input order
    title           <- title
    type            <- type, overridden to "spike" when kind == "spike"
    kind            <- kept when in {e2e, doc, verify}; dropped when "spike"
    description     <- "" (legacy carries none; schema requires the key)
    acceptance_criteria <- [] (legacy carries none; schema requires the key)
    implements      <- carried {requirement_ids, user_story_ids, test_case_ids};
                       test_case_ids set from `verified_by` when present;
                       `verified_by` itself is dropped
    covers          <- [number -> WU-id] remap of integer `covers`
    depends_on      <- [number -> WU-id] remap of `blocked_by` (WU-space
                       authority; numbers naming no unit in this file are skipped)
    tracker         <- {system:"github", ref:str(number), url, node_id,
                        blocked_by_refs:[str(n) for n in blocked_by]}
                       (url is required by the schema so always emitted, "" when
                        the legacy entry carries none; node_id omitted when absent)
    milestone / labels / target_path / trigger_reason  <- carried when present
    (every other legacy field, e.g. part_b / supersedes, is dropped so the
     schema's additionalProperties:false validation passes)

Usage:
    migrate_issues_to_work_units.py PATH [PATH ...]
    migrate_issues_to_work_units.py --check PATH [PATH ...]   # preview, no write
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import work_units  # noqa: E402

SCHEMA_ID = "https://roubo.dev/schema/work-units/v1.0.0.json"
SCHEMA_VERSION = "1.0.0"

# kind values that survive into the envelope (the schema enum). A legacy
# kind=="spike" is folded into type and the kind key is dropped.
KEPT_KINDS = ("e2e", "doc", "verify")


def spec_slug_for(path: str) -> str:
    """Derive the spec slug from a .specifications/<slug>/issues.json path."""
    return os.path.basename(os.path.dirname(os.path.abspath(path)))


def _wu_id(index: int) -> str:
    """Mint a deterministic WU id from a zero-based input index."""
    return "WU-%03d" % (index + 1)


def build_id_map(entries: list) -> dict:
    """Map each entry's issue `number` to its minted WU id (input order)."""
    id_map = {}
    for i, entry in enumerate(entries):
        number = entry.get("number")
        if number is not None:
            id_map[number] = _wu_id(i)
    return id_map


def convert_entry(entry: dict, index: int, id_map: dict) -> dict:
    """Convert one legacy issue entry into a schema-valid work unit."""
    unit: dict = {}
    unit["id"] = _wu_id(index)
    unit["title"] = entry.get("title", "")

    # type, with kind=="spike" overriding the legacy type to "spike".
    kind = entry.get("kind")
    if kind == "spike":
        unit["type"] = "spike"
    else:
        unit["type"] = entry.get("type", "")

    # kind is kept only for the schema's enum {e2e, doc, verify}.
    if kind in KEPT_KINDS:
        unit["kind"] = kind

    # Schema requires both keys present; legacy carries neither.
    unit["description"] = ""
    unit["acceptance_criteria"] = []

    # Schema-allowed carry-through extras (only when present).
    if "milestone" in entry:
        unit["milestone"] = entry["milestone"]
    if "labels" in entry:
        unit["labels"] = entry["labels"]

    # depends_on: remap blocked_by numbers to WU ids; drop numbers not present
    # as a unit in this file.
    blocked_by = entry.get("blocked_by", []) or []
    unit["depends_on"] = [id_map[n] for n in blocked_by if n in id_map]

    # implements: carry the 3-key object; verified_by feeds test_case_ids.
    implements_src = entry.get("implements") or {}
    implements = {
        "requirement_ids": list(implements_src.get("requirement_ids", []) or []),
        "user_story_ids": list(implements_src.get("user_story_ids", []) or []),
        "test_case_ids": list(implements_src.get("test_case_ids", []) or []),
    }
    if "verified_by" in entry and entry["verified_by"]:
        implements["test_case_ids"] = list(entry["verified_by"])
    unit["implements"] = implements

    # covers: remap integer issue numbers to WU ids.
    if "covers" in entry:
        covers = entry.get("covers") or []
        unit["covers"] = [id_map[n] for n in covers if n in id_map]

    if "target_path" in entry:
        unit["target_path"] = entry["target_path"]
    if "trigger_reason" in entry:
        unit["trigger_reason"] = entry["trigger_reason"]

    # tracker: folds number/url/node_id in (schema is additionalProperties:false).
    number = entry.get("number")
    tracker: dict = {"system": "github", "ref": str(number)}
    # url is required by the pinned schema (tracker.required), so always emit it;
    # default to "" when the legacy entry carries none (mirrors the description /
    # acceptance_criteria defaults) so the emitted tracker is always schema-valid.
    tracker["url"] = entry.get("url") or ""
    if "node_id" in entry:
        tracker["node_id"] = entry["node_id"]
    tracker["blocked_by_refs"] = [str(n) for n in blocked_by]
    unit["tracker"] = tracker

    return unit


def build_envelope(entries: list, slug: str) -> dict:
    """Assemble the work-units.json envelope from legacy issue entries."""
    id_map = build_id_map(entries)
    return {
        "$schema": SCHEMA_ID,
        "schemaVersion": SCHEMA_VERSION,
        "specSlug": slug,
        "units": [convert_entry(e, i, id_map) for i, e in enumerate(entries)],
    }


def _envelope_bytes(envelope: dict) -> str:
    """Serialize an envelope exactly as work_units._atomic_write_json would.

    Mirrors the writer (json.dump(indent=2) + a trailing newline) so the
    idempotency short-circuit compares like-for-like against any file on disk.
    """
    return json.dumps(envelope, indent=2) + "\n"


def _describe_mappings(envelope: dict) -> None:
    """Print the per-unit field mappings that a real run would apply."""
    for unit in envelope["units"]:
        ref = unit["tracker"]["ref"]
        parts = ["%s <- #%s" % (unit["id"], ref), "type=%s" % unit["type"]]
        if "kind" in unit:
            parts.append("kind=%s" % unit["kind"])
        if unit["depends_on"]:
            parts.append("depends_on=%s" % ",".join(unit["depends_on"]))
        if unit.get("covers"):
            parts.append("covers=%s" % ",".join(unit["covers"]))
        if unit["tracker"]["blocked_by_refs"]:
            parts.append(
                "blocked_by_refs=%s"
                % ",".join(unit["tracker"]["blocked_by_refs"]))
        if unit["implements"]["test_case_ids"]:
            parts.append(
                "test_case_ids=%s"
                % ",".join(unit["implements"]["test_case_ids"]))
        print("  " + " | ".join(parts))


def migrate_path(path: str, check_only: bool) -> int:
    """Migrate one issues.json path. Returns a per-path return code.

    1 in --check mode signals "a change would be made" (mirrors
    migrate_test_cases_to_v1_1.py); 0 otherwise.
    """
    spec_dir = os.path.dirname(os.path.abspath(path))
    slug = spec_slug_for(path)

    # Loud failure with no partial write: a parse error raises here before any
    # envelope is built or written (WUAAVG-TC-055).
    doc = work_units.load_json(path, work_units.ISSUES_NAME)
    entries = work_units.load_issue_entries(doc)

    envelope = build_envelope(entries, slug)
    # Validate the in-memory envelope so a malformed transform fails loudly
    # before any disk write (WUAAVG-TC-055).
    work_units.validate_structural(envelope)

    n = len(envelope["units"])
    # Confine the target inside spec_dir before any filesystem access: realpath
    # normalization + a containment prefix check (the same sanitizer the sibling
    # write path uses via work_units.write_envelope). An escaping path (`..`, an
    # absolute path, or a symlinked dir pointing out) raises InputError, which
    # main()'s `except work_units.InputError` maps to the exit-1 clean-stderr
    # convention. Resolves the py/path-injection finding on the existence check
    # and read below.
    out_path = work_units._resolve_in_dir(spec_dir, work_units.WORK_UNITS_NAME)
    new_bytes = _envelope_bytes(envelope)

    existing_bytes = None
    if os.path.isfile(out_path):
        with open(out_path, "r", encoding="utf-8") as fh:
            existing_bytes = fh.read()
    already_current = existing_bytes == new_bytes

    if check_only:
        if already_current:
            print("would skip (already up to date): %s" % out_path)
            return 0
        print("would convert %d units -> %s (slug=%s)" % (n, out_path, slug))
        _describe_mappings(envelope)
        return 1

    if already_current:
        print("already up to date (no-op): %s" % out_path)
        return 0

    written = work_units.write_envelope(spec_dir, envelope)
    print("converted %d units -> %s (slug=%s)" % (n, written, slug))
    return 0


def main(argv: list) -> int:
    check_only = False
    paths = []
    for arg in argv[1:]:
        if arg == "--check":
            check_only = True
        else:
            paths.append(arg)
    if not paths:
        print(__doc__)
        return 2

    rc = 0
    for path in paths:
        try:
            path_rc = migrate_path(path, check_only)
        except work_units.InputError as exc:
            work_units.log("error: %s" % exc)
            return 1
        if path_rc:
            rc = path_rc
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
