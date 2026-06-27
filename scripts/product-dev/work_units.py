#!/usr/bin/env python3
"""work_units.py: the stdlib core for the work-unit model (core I + core II).

The single authoritative home for the on-disk work-unit logic, so the readers
(`breakdown`, `align`, `review`, `document`, `e2e_coverage.py`) cannot drift.
Core I (issue #731) landed the on-disk plumbing:

    load(spec_dir)        -> the dual-read loader (the transition shim)
    write_envelope(...)   -> the atomic, never-delete-issues.json envelope writer
    validate_structural() -> internal-envelope + WorkUnit structural conformance

Core II (issue #732) adds the pure, no-network decision logic, all computed
from work-units.json / test-cases.json alone (WUAAVG-NFR-002, zero gh calls):

    project_blocked_by(units)        -> units in topological filing order with
                                        `tracker.blocked_by_refs` regenerated from
                                        `depends_on` (raises on a cycle). (FR-004, R1)
    gate_dedup(units, gating_set)    -> {already_present, existing_id}: a verify
                                        gate is present iff a unit has kind=="verify"
                                        AND "verify" in labels AND
                                        implements.test_case_ids set-equals the
                                        gating set (order-independent). (FR-009)
    gating_set(test_cases, batch)    -> the batch's L1/L2 cases plus its `e2e_flow`
                                        cases (L3/L4 excluded). (FR-007)

The GitHub tracker seam (issue #736) adds the single GitHub-only mutation
boundary, deliberately quarantined from the pure core above:

    file_unit(unit, repo, run=...)   -> the one place a work-unit's tracker
                                        manifestation is CREATED. Sequence:
                                        auth-check (before any mutation) ->
                                        create issue -> resolve node id -> set the
                                        native Issue Type from `type`
                                        (updateIssueIssueType) -> as a SEPARATE
                                        retryable step, add blocking links from
                                        `blocked_by_refs` (addBlockedBy). On a
                                        link failure after the issue is created,
                                        it persists the PARTIAL TrackerBlock and
                                        surfaces a link-only retry, exiting
                                        non-zero (WUAAVG-FR-010, WUAAVG-NFR-003).
                                        The gh-invoking callable is INJECTABLE
                                        (`run=`) so the paired tests pass a FAKE
                                        runner and never touch the network; the
                                        pure core stays network-free
                                        (WUAAVG-NFR-002/-NFR-005).

Out of scope here (later workstreams, do NOT add): the GHE/Jira adapters (only
reserved enum slots), the CapabilityBroker + audit log, the reader cutover,
breakdown's per-batch seam wiring (Phase 2), and the migration script.

The model contract is fixed by `.specifications/work-unit-adoption-and-verify-gates/`
(`work-unit-model.md` R1-R6, `architecture.md`). This module targets the
**internal** envelope shape that contract describes: a `units` array of
snake-case WorkUnit fields. This shape now MATCHES the pinned external
`schema/work-units.schema.json` (the canonical Roubo #697 bytes: `units`,
snake-case), which superseded the earlier provisional `workUnits`/camelCase
skeleton (#756). This module performs a lighter structural SUBSET check; full
JSON-Schema (Draft 2020-12) validation against the pinned schema runs in CI
(the `work-units-schema` job in `.github/workflows/verify.yml`), not here.

Conventions mirror the sibling scripts: `e2e_coverage.py`'s `InputError`->exit 1,
`load_json`, and tolerant shape detection; `codec.py` / `apply_doc.py`'s atomic
write (`tempfile.mkstemp` in the same dir + `os.replace`) and the `os.path.realpath`
containment guard. Stdlib only.

Subcommands:
    load     --spec-dir DIR
        Dual-read load. Prefer `work-units.json` (`units`), fall back to
        `issues.json` (`issues` / `entries`). Emit `{units, source}` on stdout.
        Exit 1 with an actionable message when a folder carries NEITHER file,
        never an empty-set success. (WUAAVG-FR-013, WUAAVG-NFR-001)

    write    --spec-dir DIR        (reads the envelope JSON on stdin)
        Validate structurally, then write `work-units.json` atomically (mkstemp +
        os.replace in the same dir). REFUSE to delete or overwrite `issues.json`;
        REFUSE any path resolving outside `spec_dir`. (WUAAVG-NFR-001)

    validate                       (reads the envelope JSON on stdin)
        Structural conformance of the internal envelope: the envelope keys
        (`$schema`, `schemaVersion` == "1.0.0", `specSlug`, `units`) and each
        unit's required fields. Exit 0 on pass, 1 on failure.

    project                        (reads the units array OR envelope on stdin)
        Regenerate `tracker.blocked_by_refs` from `depends_on` and emit the units
        in topological filing order. Exit 1 on a dependency cycle. Zero gh calls.
        (WUAAVG-FR-004, R1)

    gate-dedup --gating-set TC-... (reads the units array OR envelope on stdin)
        Decide whether a verify gate for the given gating set already exists.
        Emits `{already_present, existing_id}`. Reads the units only, issues zero
        gh calls. (WUAAVG-FR-009, WUAAVG-NFR-002)

    gating-set [--batch TC-...]    (reads the test-cases array OR doc on stdin)
        Compute a batch's gating test set: its L1/L2 cases plus its `e2e_flow`
        cases (L3/L4 excluded). `--batch` scopes membership to those TC ids; when
        omitted, every supplied case is considered. (WUAAVG-FR-007)

    drift-report --spec-dir DIR [--test-results PATH]
        Report-only results-aware drift over a feature folder: reads the work
        units (dual-read), test-cases.json, and test-results.json, and emits
        `{gating_set_drift[], stale_gates[], orphaned_results[], skipped, note}`.
        NEVER auto-fixes. An absent test-results.json is a CLEAN skip (empty
        report + a one-line info note, exit 0), never an error. (WUAAVG-FR-014,
        WUAAVG-FR-015)

    file-unit  --repo owner/name [--retry-links-only]
                                   (reads ONE unit / envelope / list on stdin)
        File one work unit through the GitHub tracker seam: `gh auth status`
        (before any mutation) -> create issue -> resolve node id -> set the native
        Issue Type from `type` -> as a separate retryable step, add the blocking
        links from `tracker.blocked_by_refs`. Emits `{tracker: TrackerBlock}` on
        success. On a link-step failure AFTER issue creation, emits the PARTIAL
        block (`{tracker, partial: true}`) to stdout, an actionable link-only
        retry message to stderr, and exits 1, never a silent success
        (WUAAVG-FR-010, WUAAVG-NFR-003). `--retry-links-only` re-applies only the
        blocking links for a unit whose issue already exists (no duplicate
        issue). gh unauthenticated/unavailable, or a reserved `tracker.system`
        ('ghe'/'jira'), exits 1 with an actionable message before any file.

    --selftest
        Run inline in-memory fixtures and exit 0 on pass.

Exit codes:
    0  success (including a passing --selftest / validate, and a fully-linked
       file-unit).
    1  bad/missing input or a recoverable tracker failure: neither-file load, a
       structural-validation failure, an unreadable/unparseable file, a refused
       write (issues.json clobber or out-of-folder path), a dependency cycle in
       `project`, gh unauthenticated/unavailable or a reserved tracker.system in
       `file-unit` (no issue filed), or a `file-unit` link-step failure after the
       issue was created (the PARTIAL block is emitted to stdout for persistence;
       re-run with --retry-links-only). An error is written to stderr; on a
       before-mutation failure nothing partial is written.
    2  argparse usage error (unknown subcommand, missing required arg).
"""

import argparse
import json
import os
import re
import sys
import tempfile

WORK_UNITS_NAME = "work-units.json"
ISSUES_NAME = "issues.json"
TEST_CASES_NAME = "test-cases.json"
TEST_RESULTS_NAME = "test-results.json"

SCHEMA_VERSION = "1.0.0"

# Required envelope keys (the internal shape, per work-unit-model.md "Envelope").
ENVELOPE_REQUIRED = ("$schema", "schemaVersion", "specSlug", "units")

# Required WorkUnit fields (per work-unit-model.md "Unit": the always-required
# subset). `depends_on` and `implements` are required-but-may-be-empty in the
# full model, but the projection/dedup that consume them are core II; core I
# checks the always-present identity/body/category fields.
UNIT_REQUIRED = ("id", "title", "type", "description", "acceptance_criteria")

UNIT_TYPES = ("feature", "task", "spike", "bug")


def log(msg):
    print(msg, file=sys.stderr)


class InputError(Exception):
    """Raised for a bad/missing input, a structural failure, or a refused write.

    All of these map to exit 1: an actionable message on stderr, nothing partial
    written to stdout, and (for a refused write) no file mutated.
    """


# --------------------------------------------------------------------------
# Loading (the dual-read shim, WUAAVG-FR-013)
# --------------------------------------------------------------------------

def load_json(path, label):
    """Load and parse a JSON file, raising InputError (exit 1) on any failure."""
    if not os.path.isfile(path):
        raise InputError("%s not found or not a file: %s" % (label, path))
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        raise InputError("%s is unreadable or unparseable: %s" % (label, exc))


def _units_from_envelope(doc):
    """Return the `units` list from a parsed work-units.json envelope.

    Tolerates either the full envelope object (the canonical shape, carrying
    `units`) or a bare list. Raises InputError when no list is present.
    """
    if isinstance(doc, list):
        units = doc
    elif isinstance(doc, dict):
        units = doc.get("units")
    else:
        units = None
    if not isinstance(units, list):
        raise InputError(
            "%s does not contain a `units` list" % WORK_UNITS_NAME)
    return [u for u in units if isinstance(u, dict)]


def load_issue_entries(doc):
    """Return the entry list from a parsed issues.json document (legacy shape).

    Mirrors `e2e_coverage.py`'s tolerant shape detection: a bare list, or a
    wrapper object carrying the list under `issues` / `entries`.
    """
    if isinstance(doc, list):
        entries = doc
    elif isinstance(doc, dict):
        entries = doc.get("issues")
        if entries is None:
            entries = doc.get("entries")
    else:
        entries = None
    if not isinstance(entries, list):
        raise InputError(
            "%s does not contain an `issues`/`entries` list" % ISSUES_NAME)
    return [e for e in entries if isinstance(e, dict)]


def load(spec_dir):
    """Dual-read load over a feature folder (WUAAVG-FR-013, WUAAVG-NFR-001).

    Prefer `work-units.json` (by `units`); fall back to `issues.json` (by
    `issues` / `entries`). Returns `{"units": [...], "source": <filename>}`.

    Raises InputError (exit 1) with an actionable message when the folder
    carries NEITHER file: a neither-file folder is never an empty-set success,
    because the caller cannot tell "no work" from "wrong folder / nothing read".
    """
    # Normalize-and-confine each spec-dir-relative read before it reaches
    # os.path.isfile / open, so a traversing or absolute spec_dir cannot escape
    # the folder (py/path-injection barrier, WUAAVG-NFR-001).
    wu_path = _confine(spec_dir, WORK_UNITS_NAME, verb="read")
    issues_path = _confine(spec_dir, ISSUES_NAME, verb="read")

    if os.path.isfile(wu_path):
        units = _units_from_envelope(load_json(wu_path, WORK_UNITS_NAME))
        return {"units": units, "source": WORK_UNITS_NAME}

    if os.path.isfile(issues_path):
        units = load_issue_entries(load_json(issues_path, ISSUES_NAME))
        return {"units": units, "source": ISSUES_NAME}

    raise InputError(
        "no work-unit file in %s: expected %s (preferred) or %s (legacy). "
        "Refusing to proceed with an empty set; check the folder path."
        % (spec_dir, WORK_UNITS_NAME, ISSUES_NAME))


# --------------------------------------------------------------------------
# Structural conformance (the internal envelope shape)
# --------------------------------------------------------------------------

def validate_structural(envelope):
    """Structurally validate the INTERNAL work-units envelope; raise on failure.

    Checks the envelope keys (`$schema`, `schemaVersion` == "1.0.0", `specSlug`,
    `units`) and each unit's required fields (`id`, `title`, `type`,
    `description`, `acceptance_criteria`), with `type` constrained to the model's
    enum. Returns True on success; raises InputError (exit 1) on the first
    failure with an actionable, path-pointing message.

    This is a lighter structural SUBSET check of the internal shape (`units`,
    snake-case) per work-unit-model.md, which now aligns with the pinned external
    `schema/work-units.schema.json` (the canonical Roubo #697 bytes; #756). Full
    JSON-Schema validation against the pinned schema runs in CI (the
    `work-units-schema` job), not here.
    """
    if not isinstance(envelope, dict):
        raise InputError("envelope must be a JSON object, got %s"
                         % type(envelope).__name__)

    missing = [k for k in ENVELOPE_REQUIRED if k not in envelope]
    if missing:
        raise InputError("envelope is missing required key(s): %s"
                         % ", ".join(missing))

    if envelope.get("schemaVersion") != SCHEMA_VERSION:
        raise InputError(
            "envelope schemaVersion must be %r, got %r"
            % (SCHEMA_VERSION, envelope.get("schemaVersion")))

    if not isinstance(envelope.get("specSlug"), str) or not envelope["specSlug"]:
        raise InputError("envelope specSlug must be a non-empty string")

    units = envelope.get("units")
    if not isinstance(units, list):
        raise InputError("envelope units must be a list")

    for i, unit in enumerate(units):
        if not isinstance(unit, dict):
            raise InputError("units[%d] must be a JSON object" % i)
        unit_missing = [k for k in UNIT_REQUIRED if k not in unit]
        if unit_missing:
            raise InputError(
                "units[%d] (id=%r) is missing required field(s): %s"
                % (i, unit.get("id"), ", ".join(unit_missing)))
        if unit.get("type") not in UNIT_TYPES:
            raise InputError(
                "units[%d] (id=%r) type must be one of %s, got %r"
                % (i, unit.get("id"), "/".join(UNIT_TYPES), unit.get("type")))
        if not isinstance(unit.get("acceptance_criteria"), list):
            raise InputError(
                "units[%d] (id=%r) acceptance_criteria must be a list"
                % (i, unit.get("id")))

    return True


# --------------------------------------------------------------------------
# Writing (atomic, never-delete-issues.json, in-folder only; WUAAVG-NFR-001)
# --------------------------------------------------------------------------

def _confine(spec_dir, name, verb="access"):
    """Resolve `name` to a real path confined inside `spec_dir`, or refuse.

    The shared normalize-and-confine barrier for BOTH the read and the write
    side. Mirrors apply_doc.py's `resolve_in_root`: the symlink-resolved real
    path MUST sit inside the real spec_dir, even when the leaf file does not yet
    exist (a create), so a path escaping the folder (`..`, an absolute path, or a
    symlinked dir pointing out) is refused before any fs access (WUAAVG-NFR-001).

    This is the control CodeQL recognizes for `py/path-injection` (CWE-22): an
    `os.path.realpath` normalization followed by a `startswith(real_dir + sep)`
    containment check. Routing every operator-supplied, spec-dir-relative path
    through it before `open()` / `os.path.isfile()` neutralizes path traversal on
    the read path the same way `write_envelope` already guards the write path.
    `verb` only tunes the refusal text ("read" / "write" / "access").
    """
    real_dir = os.path.realpath(spec_dir)
    candidate = name if os.path.isabs(name) else os.path.join(real_dir, name)
    real_path = os.path.realpath(candidate)
    if real_path != real_dir and not real_path.startswith(real_dir + os.sep):
        raise InputError(
            "refusing to %s outside spec dir: %s resolves to %s (dir %s)"
            % (verb, name, real_path, real_dir))
    return real_path


def _resolve_in_dir(spec_dir, name):
    """Confine a WRITE target inside `spec_dir`, or refuse (WUAAVG-NFR-001).

    A thin write-side alias over `_confine` so the refusal text stays write
    specific; the containment logic itself lives in one place.
    """
    return _confine(spec_dir, name, verb="write")


def _atomic_write_json(path, obj):
    """Atomically write `obj` as pretty JSON to `path`.

    Temp file in the SAME directory, then os.replace (atomic rename on POSIX +
    Windows), mirroring codec.py / apply_doc.py: an interruption leaves either
    the old file or the new one, never a truncated half-write.
    """
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".work-units-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except OSError:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_envelope(spec_dir, envelope):
    """Validate then atomically write `work-units.json` to `spec_dir`.

    The additive-migration invariant (WUAAVG-NFR-001): this writes only
    `work-units.json` and NEVER deletes or overwrites `issues.json` (legacy
    removal is the separate shim-drop step). It refuses any target path that
    resolves outside `spec_dir`. The write is structurally validated first, so a
    malformed envelope never reaches the disk.

    Returns the real path written.
    """
    validate_structural(envelope)

    # Existence guard: a missing spec dir is operator input, not a crash. Catch it
    # here as an InputError so it maps to the documented exit-1 clean-stderr
    # contract rather than an uncaught FileNotFoundError from `tempfile.mkstemp`.
    if not os.path.isdir(spec_dir):
        raise InputError("spec dir does not exist or is not a directory: %s"
                         % spec_dir)

    # Containment guard first: refuse an out-of-folder target before touching fs.
    target = _resolve_in_dir(spec_dir, WORK_UNITS_NAME)

    # Never-delete / never-overwrite guard: the writer only ever names
    # work-units.json. Assert it can never resolve onto issues.json (a defensive
    # invariant: even a future refactor that passed a different name in cannot
    # clobber the legacy file through this function).
    issues_real = os.path.realpath(os.path.join(spec_dir, ISSUES_NAME))
    if target == issues_real:
        raise InputError(
            "refusing to overwrite %s: the work-unit writer never touches the "
            "legacy file (additive migration, WUAAVG-NFR-001)" % ISSUES_NAME)

    _atomic_write_json(target, envelope)
    return target


# --------------------------------------------------------------------------
# Core II: dependency projection + verify-gate dedup + gating-set
#
# All three are pure, no-network decisions over data already on disk: they read
# the parsed `units` / `test_cases` and issue ZERO gh / tracker calls
# (WUAAVG-NFR-002). They mirror core I's InputError -> exit-1 convention.
# --------------------------------------------------------------------------

VERIFY_KIND = "verify"
VERIFY_LABEL = "verify"

# Test-case levels and the e2e type that compose a batch's gating set. L1/L2 gate;
# L3/L4 are tracked but excluded (verify-gate.md "Gating policy"). The `e2e_flow`
# type gates regardless of level.
GATING_LEVELS = (1, 2)
E2E_FLOW_TYPE = "e2e_flow"


def _topo_order(units):
    """Return `units` in topological filing order over `depends_on`.

    A unit must be filed after every `WU-` id it `depends_on`, so the blocker's
    `tracker.ref` already exists when its `blocked_by_refs` is resolved (R1).
    Uses Kahn's algorithm; ties are broken by the units' original input order so
    the output is deterministic. `depends_on` ids that name no known unit are
    ignored as edges (a dangling dependency does not block ordering), but a true
    cycle among known units raises InputError (exit 1).

    Returns a new list of the same unit dicts (not copies); does not mutate.
    """
    by_id = {}
    for u in units:
        uid = u.get("id")
        if uid is not None:
            by_id.setdefault(uid, u)

    # Build the dependency edges, restricted to ids that name a known unit.
    order_index = {id(u): i for i, u in enumerate(units)}
    deps = {}
    for u in units:
        raw = u.get("depends_on") or []
        deps[id(u)] = [d for d in raw if d in by_id and by_id[d] is not u]

    # indegree = number of (known) blockers each unit still waits on.
    indeg = {id(u): len(deps[id(u)]) for u in units}
    # reverse edges: blocker -> units that depend on it.
    dependents = {id(u): [] for u in units}
    for u in units:
        for d in deps[id(u)]:
            dependents[id(by_id[d])].append(u)

    # Kahn: start with the units that block on nothing, lowest input index first.
    ready = sorted((u for u in units if indeg[id(u)] == 0),
                   key=lambda u: order_index[id(u)])
    ordered = []
    while ready:
        u = ready.pop(0)
        ordered.append(u)
        newly = []
        for dep in dependents[id(u)]:
            indeg[id(dep)] -= 1
            if indeg[id(dep)] == 0:
                newly.append(dep)
        if newly:
            ready.extend(newly)
            ready.sort(key=lambda u: order_index[id(u)])

    if len(ordered) != len(units):
        stuck = sorted(u.get("id") for u in units
                       if u not in ordered)
        raise InputError(
            "dependency cycle detected among work units: %s cannot be filed in "
            "topological order (depends_on must be acyclic, WUAAVG-FR-004)"
            % ", ".join(repr(s) for s in stuck))
    return ordered


def project_blocked_by(units):
    """Regenerate `tracker.blocked_by_refs` from `depends_on`; topo-order units.

    `depends_on` (WU- ids) is the dependency authority; `tracker.blocked_by_refs`
    is a DERIVED projection regenerated on every file (R1, WUAAVG-FR-004). For
    each unit, each `depends_on` WU- id is resolved to that blocker's
    `tracker.ref`, and the unit is emitted in topological filing order so a
    blocker is always filed before the unit that depends on it.

    A dependency cycle is rejected: raises InputError (exit 1).

    A blocker that has no `tracker.ref` yet (not filed) is handled gracefully: it
    contributes no ref to the dependent's `blocked_by_refs` (the projection can
    only reference refs that exist), rather than crashing. A `depends_on` id that
    names no known unit is likewise skipped.

    Returns a NEW list of NEW unit dicts (deep-ish copy of the tracker block);
    the input units are not mutated. Pure: zero gh / tracker calls.
    """
    if not isinstance(units, list):
        raise InputError("project_blocked_by expects a list of units, got %s"
                         % type(units).__name__)
    units = [u for u in units if isinstance(u, dict)]

    ordered = _topo_order(units)

    by_id = {}
    for u in units:
        uid = u.get("id")
        if uid is not None:
            by_id.setdefault(uid, u)

    result = []
    for u in ordered:
        out = dict(u)
        refs = []
        seen = set()
        for dep in (u.get("depends_on") or []):
            blocker = by_id.get(dep)
            if blocker is None:
                continue
            ref = (blocker.get("tracker") or {}).get("ref")
            if ref is None or ref == "":
                # Blocker not filed yet: cannot project a ref. Graceful skip.
                continue
            if ref not in seen:
                seen.add(ref)
                refs.append(ref)
        # Only attach/refresh blocked_by_refs when the unit already carries a
        # tracker block (an unfiled unit has no tracker projection to update).
        if isinstance(u.get("tracker"), dict):
            tracker = dict(u["tracker"])
            tracker["blocked_by_refs"] = refs
            out["tracker"] = tracker
        result.append(out)
    return result


def _gate_test_case_ids(unit):
    """Return the set of `implements.test_case_ids` for a unit, or empty set."""
    implements = unit.get("implements")
    if not isinstance(implements, dict):
        return set()
    ids = implements.get("test_case_ids")
    if not isinstance(ids, list):
        return set()
    return set(ids)


def is_verify_gate(unit):
    """Return True iff `unit` is a verify gate by the dedup-key predicate.

    The ONE shared gate predicate (verify-gate.md "Dedup key", WUAAVG-FR-009): a
    unit is a verify gate iff `kind == "verify"` AND `labels` contains `"verify"`.
    `gate_dedup` (the set-equality check) and `drift_report` (the gating-set /
    stale-gate pass) BOTH route gate identification through this one helper, so the
    two readers can never diverge on what counts as a gate.
    """
    if not isinstance(unit, dict):
        return False
    if unit.get("kind") != VERIFY_KIND:
        return False
    labels = unit.get("labels")
    return isinstance(labels, list) and VERIFY_LABEL in labels


def gate_dedup(units, gating_set):
    """Decide whether a verify gate for `gating_set` already exists in `units`.

    A gate is ALREADY PRESENT iff some unit satisfies all three of the dedup key
    (verify-gate.md "Dedup key", WUAAVG-FR-009):

      * `kind == "verify"`, AND
      * `labels` contains `"verify"`, AND
      * `implements.test_case_ids` set-EQUALS `gating_set` (order-independent).

    Reads the units only and issues ZERO gh calls (WUAAVG-NFR-002): the decision
    is resolved from work-units.json alone.

    Returns `{"already_present": bool, "existing_id": <id> | None}`. On a match,
    `existing_id` is the matching unit's `id`.
    """
    if not isinstance(units, list):
        raise InputError("gate_dedup expects a list of units, got %s"
                         % type(units).__name__)
    want = set(gating_set)
    for unit in units:
        if not is_verify_gate(unit):
            continue
        if _gate_test_case_ids(unit) == want:
            return {"already_present": True, "existing_id": unit.get("id")}
    return {"already_present": False, "existing_id": None}


def gating_set(test_cases, batch=None):
    """Compute a batch's gating test set: L1/L2 cases plus its `e2e_flow` cases.

    The gating set is, per verify-gate.md "Gating policy", the batch's L1 and L2
    cases plus its `e2e_flow`-type cases; L3 and L4 cases are tracked but EXCLUDED
    (WUAAVG-FR-007). A case gates when `level in {1, 2}` OR `type == "e2e_flow"`.

    `test_cases` is a list of case dicts (each with `id`, `level`, `type`).
    `batch` optionally scopes membership: when it is an iterable of TC ids, only
    cases whose `id` is in it are considered; when None, every case is. This lets
    a caller pass the full test-cases.json and the batch's TC ids separately.

    Returns the gating TC ids as a sorted list (deterministic, order-independent
    by construction). Pure: zero gh calls.
    """
    if not isinstance(test_cases, list):
        raise InputError("gating_set expects a list of test cases, got %s"
                         % type(test_cases).__name__)
    batch_ids = set(batch) if batch is not None else None

    gating = set()
    for case in test_cases:
        if not isinstance(case, dict):
            continue
        cid = case.get("id")
        if cid is None:
            continue
        if batch_ids is not None and cid not in batch_ids:
            continue
        level = case.get("level")
        ctype = case.get("type")
        if level in GATING_LEVELS or ctype == E2E_FLOW_TYPE:
            gating.add(cid)
    return sorted(gating)


# --------------------------------------------------------------------------
# align's results-aware drift pass (WUAAVG-FR-014, WUAAVG-FR-015).
#
# A REPORT-ONLY pass over `test-results.json` (Roubo's TestBench v2.0.0 shape:
# per-case `derivedStatus`, an optional `statusOverride`, a `planHash` over the
# plan, and `orphaned` markers). It surfaces three finding types and NEVER
# auto-fixes any of them (the issue's Out of scope + verify-gate.md "Drift
# (align)"):
#
#   gating_set_drift  - a kind:"verify" gate whose implements.test_case_ids has
#                       drifted from its batch's actual L1/L2 + e2e_flow set.
#   stale_gates       - results.planHash missing or mismatched vs the current
#                       test-cases plan (planHash is opaque/out of scope; any
#                       missing-or-mismatched value reads as stale, never passed).
#   orphaned_results  - a case marked in test-results.json (or flagged
#                       `orphaned`) that no longer exists in test-cases.json.
#
# Pure + no network: reads only the three on-disk files via `load` /
# `load_json` (WUAAVG-NFR-002). Gate identification routes through the ONE shared
# `is_verify_gate` predicate, so the gating-set drift check and `gate_dedup` can
# never disagree on what a gate is.
# --------------------------------------------------------------------------

def _plan_hash(test_cases):
    """Return the current plan hash over `test-cases.json`.

    `planHash` is a Roubo-owned opaque value: its exact field set / ordering is
    UNDEFINED in the in-repo contracts (architecture.md open question line ~123),
    so `align` does not invent the algorithm. It computes a STABLE local digest
    over the cases' `(id, level, type)` tuples purely so two identical plans hash
    equal and an unrelated plan hashes differently; the absolute value is never
    asserted against Roubo's. Any missing/mismatched results `planHash` is treated
    as stale regardless (see `drift_report`).
    """
    import hashlib
    norm = sorted(
        (str(c.get("id")), c.get("level"), c.get("type"))
        for c in test_cases if isinstance(c, dict) and c.get("id") is not None)
    return hashlib.sha256(
        json.dumps(norm, sort_keys=True).encode("utf-8")).hexdigest()


def _result_case_ids(results_doc):
    """Return (all_result_ids, explicitly_orphaned_ids) from a test-results doc.

    Tolerant of the v2.0.0 shape: `caseResults` may be a list of objects each
    carrying an `id`/`caseId`/`testCaseId` and an optional `orphaned` flag, or a
    dict keyed by TC id. A top-level `orphaned` list (ids) is also honoured.
    """
    all_ids = []
    orphaned = set()

    def _add(cid, is_orphan):
        if cid is None:
            return
        cid = str(cid)
        all_ids.append(cid)
        if is_orphan:
            orphaned.add(cid)

    case_results = None
    if isinstance(results_doc, dict):
        case_results = results_doc.get("caseResults")
        if case_results is None:
            case_results = results_doc.get("results")
        top_orphaned = results_doc.get("orphaned")
        if isinstance(top_orphaned, list):
            for cid in top_orphaned:
                _add(cid, True)
    elif isinstance(results_doc, list):
        case_results = results_doc

    if isinstance(case_results, dict):
        for cid, rec in case_results.items():
            is_orphan = bool(isinstance(rec, dict) and rec.get("orphaned"))
            _add(cid, is_orphan)
    elif isinstance(case_results, list):
        for rec in case_results:
            if not isinstance(rec, dict):
                continue
            cid = (rec.get("id") or rec.get("caseId")
                   or rec.get("testCaseId"))
            _add(cid, bool(rec.get("orphaned")))

    # de-dup all_ids while preserving first-seen order
    seen = set()
    deduped = []
    for cid in all_ids:
        if cid not in seen:
            seen.add(cid)
            deduped.append(cid)
    return deduped, orphaned


def drift_report(spec_dir, test_results_path=None):
    """Report-only results-aware drift over a feature folder (WUAAVG-FR-014).

    Reads the work units (via the dual-read `load`, so it sees the new
    units/depends_on/kind shape when `work-units.json` is present and falls back
    to `issues.json` otherwise, WUAAVG-FR-015/TC-048), `test-cases.json`, and
    `test-results.json`, and returns:

        {gating_set_drift: [...], stale_gates: [...], orphaned_results: [...],
         skipped: bool, note: str}

    NEVER auto-fixes: this is the producer of findings only (the issue's Out of
    scope: "Auto-fixing any finding"). Pure + no network (WUAAVG-NFR-002).

    Finding types:

      * `gating_set_drift`: for each verify gate (`is_verify_gate`), compare its
        `implements.test_case_ids` against its BATCH's actual gating set (the
        batch = the gate's `depends_on` slice units; the batch's gating set =
        `gating_set` over the union of those slices' `test_case_ids`, L1/L2 +
        e2e_flow only, L3/L4 excluded per TC-047). A mismatch reports the
        missing/extra TC ids.
      * `stale_gates`: when the results `planHash` is absent or does not match the
        current test-cases plan hash, every verify gate is stale (planHash is
        opaque/out of scope, so missing == mismatched == stale).
      * `orphaned_results`: a TC id present in `test-results.json` (or flagged
        `orphaned`) that is absent from `test-cases.json`.

    **Absent `test-results.json`** (the common case: 15/15 in-repo specs today)
    is a CLEAN skip, never an error: an empty report plus a one-line info note,
    exit 0 (WUAAVG-FR-014, TC-043).
    """
    # Resolve the results path (default: alongside the spec folder), then confine
    # it inside spec_dir before any os.path.isfile / open: the operator-supplied
    # --test-results value is untrusted argv (py/path-injection barrier).
    if test_results_path is None:
        test_results_path = _confine(spec_dir, TEST_RESULTS_NAME, verb="read")
    else:
        test_results_path = _confine(spec_dir, test_results_path, verb="read")

    empty = {"gating_set_drift": [], "stale_gates": [], "orphaned_results": []}

    if not os.path.isfile(test_results_path):
        result = dict(empty)
        result["skipped"] = True
        result["note"] = (
            "%s absent in %s: results-aware drift pass skipped (info, not an "
            "error)." % (TEST_RESULTS_NAME, spec_dir))
        return result

    # The work units (dual-read: new shape preferred, issues.json fallback).
    loaded = load(spec_dir)
    units = loaded["units"]

    # test-cases.json: needed for the gating-set recompute, the plan hash, and the
    # orphaned-result membership test. Its absence is an input error (a folder with
    # results but no test-cases cannot be drift-checked).
    tc_path = _confine(spec_dir, TEST_CASES_NAME, verb="read")
    tc_doc = load_json(tc_path, TEST_CASES_NAME)
    if isinstance(tc_doc, dict):
        test_cases = [c for c in (tc_doc.get("cases") or []) if isinstance(c, dict)]
    elif isinstance(tc_doc, list):
        test_cases = [c for c in tc_doc if isinstance(c, dict)]
    else:
        test_cases = []
    tc_ids = {str(c.get("id")) for c in test_cases if c.get("id") is not None}

    results_doc = load_json(test_results_path, TEST_RESULTS_NAME)

    gating_set_drift = []
    stale_gates = []
    orphaned_results = []

    gates = [u for u in units if is_verify_gate(u)]

    # --- gating-set drift: per gate, gate set vs its batch's actual gating set ---
    by_id = {}
    for u in units:
        uid = u.get("id")
        if uid is not None:
            by_id.setdefault(uid, u)

    for gate in gates:
        gate_set = _gate_test_case_ids(gate)
        # The batch = this gate's depends_on slice units; the batch's TC universe
        # is the union of those slices' implements.test_case_ids.
        batch_tc_ids = set()
        for dep in (gate.get("depends_on") or []):
            slice_unit = by_id.get(dep)
            if slice_unit is None:
                continue
            batch_tc_ids |= _gate_test_case_ids(slice_unit)
        # A gate with no resolvable slices falls back to its own declared set as
        # the batch universe, so a self-consistent gate never spuriously drifts.
        if not batch_tc_ids:
            batch_tc_ids = set(gate_set)
        actual = set(gating_set(test_cases, batch=batch_tc_ids))
        if actual != gate_set:
            gating_set_drift.append({
                "gate_id": gate.get("id"),
                "gate_test_case_ids": sorted(gate_set),
                "batch_gating_set": sorted(actual),
                "missing_from_gate": sorted(actual - gate_set),
                "extra_in_gate": sorted(gate_set - actual),
            })

    # --- stale gates: results planHash absent or mismatched vs current plan ---
    results_plan_hash = (results_doc.get("planHash")
                         if isinstance(results_doc, dict) else None)
    current_plan_hash = _plan_hash(test_cases)
    if not results_plan_hash or results_plan_hash != current_plan_hash:
        reason = ("results planHash is absent" if not results_plan_hash
                  else "results planHash does not match the current "
                       "test-cases.json plan hash")
        for gate in gates:
            stale_gates.append({
                "gate_id": gate.get("id"),
                "results_plan_hash": results_plan_hash,
                "reason": reason,
            })

    # --- orphaned results: a marked case no longer in test-cases.json ---
    result_ids, explicit_orphans = _result_case_ids(results_doc)
    seen = set()
    for cid in result_ids:
        if cid in tc_ids:
            continue
        if cid in seen:
            continue
        seen.add(cid)
        orphaned_results.append({
            "test_case_id": cid,
            "orphaned_flag": cid in explicit_orphans,
        })

    return {
        "gating_set_drift": gating_set_drift,
        "stale_gates": stale_gates,
        "orphaned_results": orphaned_results,
        "skipped": False,
        "note": "",
    }


# --------------------------------------------------------------------------
# Tracker seam: the single GitHub-only mutation boundary (WUAAVG-FR-010,
# WUAAVG-NFR-003).
#
# This is the ONE place a work-unit's tracker manifestation is created. It is
# deliberately quarantined from the pure core above: the core (load / project /
# dedup / gating-set) issues ZERO network calls (WUAAVG-NFR-002/-NFR-005), and
# this seam is the only network-touching code. To keep the module stdlib-only
# and the paired tests no-network (the `scripts-stdlib-only` CI gate), the
# gh-invoking callable is INJECTABLE: `file_unit(..., run=...)` defaults to a
# real subprocess-based gh runner, and tests pass a fake runner.
# --------------------------------------------------------------------------

# Map the work-unit `type` to the GitHub NATIVE Issue Type name (the issue's
# acceptance criteria: feature->Feature, task->Task, spike->Spike, bug->Bug).
# When the named native type is absent/unconfigured in the target repo, the seam
# SKIPS setting the type and logs a warning (gh-cli-recipes "If no match is found
# for a type, skip setting it and log a warning"); it never invents a type and
# never crashes. The recipe documents a spike->Task fallback for repos with no
# native Spike type; that fallback is precisely the skip-and-warn below, so this
# table follows the issue's mapping (spike->Spike) without contradicting it.
TYPE_TO_NATIVE = {
    "feature": "Feature",
    "task": "Task",
    "spike": "Spike",
    "bug": "Bug",
}

# Only `github` is implemented; `ghe` / `jira` are reserved enum slots that MUST
# degrade loudly (a clear "not implemented" message + non-zero exit), never a
# silent no-op (WUAAVG-TC-024).
IMPLEMENTED_TRACKER_SYSTEMS = ("github",)
RESERVED_TRACKER_SYSTEMS = ("ghe", "jira")

# Hardcoded allowlist of the only `gh` subcommands this module ever issues:
# `auth status`, `api graphql`, and `api --method=POST .../issues` (REST issue
# creation). `_gh_runner` validates the subcommand (argv[0]) against this set
# before shelling out, so a value that managed to flow into argv cannot pivot
# `gh` into an unintended subcommand (defence-in-depth argument barrier;
# CWE-78/88). Membership check is the sanitizer.
_GH_ALLOWED_SUBCOMMANDS = frozenset({"auth", "api"})

# The ONLY option-shaped tokens (those starting with `-`) the module ever puts
# in a gh argv: the bare `-f` (GraphQL field flag) and the joined `--method=...`
# / `--input=...` flags whose VALUES are hardcoded constants (`POST`, `-`), never
# user data. `_gh_runner` rejects any other dash-leading token, so a value that
# reached argv could not smuggle in an extra flag (argument injection, CWE-88).
# User data never rides on the command line at all: free-form fields go on STDIN
# (see `_create_issue`) and the few interpolated identifiers are reduced to a
# safe character set first (see `_safe_gh_value`).
_GH_BARE_FLAGS = frozenset({"-f"})
_GH_VALUE_FLAG_RE = re.compile(r"\A--(?:method|input)=")

# A repo reference is interpolated into the gh command line (the REST endpoint
# path) AND into GraphQL query strings. `_REPO_RE` enforces a strict `owner/name`
# shape; `_safe_gh_value` then rebuilds it from an allowlisted character set,
# which is the control CodeQL recognises on the argv-sourced `repo` taint path.
_REPO_RE = re.compile(r"\A[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\Z")


class TrackerError(Exception):
    """Raised when a tracker mutation fails AFTER the issue was created.

    Distinct from InputError: this carries the PARTIAL TrackerBlock (ref/url set,
    blocked_by_refs still pending) so the caller can persist it and surface a
    link-only retry (WUAAVG-NFR-003). It maps to a non-zero exit, never a silent
    success: a gate must never look passable while a link fix is outstanding.
    """

    def __init__(self, message, partial=None):
        super().__init__(message)
        self.partial = partial


def _validate_gh_argv(args):
    """Return a validated argv list or raise ValueError.

    The barrier `_gh_runner` applies before shelling out. It sits on the WHOLE
    argv (not just the subcommand) as defence-in-depth: even though no
    user-derived value reaches the command line any more (free-form fields ride
    on STDIN and interpolated identifiers pass through `_safe_gh_value` first),
    the argv is still pinned to exactly the shapes this module emits. argv must
    be:

      1. a non-empty sequence of strings;
      2. whose first element (the gh subcommand) is in `_GH_ALLOWED_SUBCOMMANDS`;
      3. whose every OTHER element either does NOT start with `-` (a plain
         positional value), or is one of the hardcoded option tokens this module
         emits: a bare flag in `_GH_BARE_FLAGS`, or a joined `--flag=value` whose
         flag name is in the `_GH_VALUE_FLAG_RE` allowlist (and whose value is a
         hardcoded constant, never user data).

    Rule 3 is the argument-injection (CWE-88) control: the only dash-leading
    tokens permitted are hardcoded flag names, so nothing that reached argv could
    be parsed as an extra option. Non-string argv elements are rejected outright.
    """
    argv = list(args)
    if not argv:
        raise ValueError("empty argv")
    if not all(isinstance(a, str) for a in argv):
        raise ValueError("all argv elements must be strings")
    if argv[0] not in _GH_ALLOWED_SUBCOMMANDS:
        raise ValueError("disallowed gh subcommand %r" % (argv[0],))
    for tok in argv[1:]:
        if not tok.startswith("-"):
            continue
        if tok in _GH_BARE_FLAGS or _GH_VALUE_FLAG_RE.match(tok):
            continue
        raise ValueError("disallowed option-shaped gh argument %r" % (tok,))
    return argv


def _gh_runner(args, input_text=None):
    """The real gh runner: shell out to `gh` and return (rc, stdout, stderr).

    `args` is the argv AFTER the `gh` program name (e.g. ["auth", "status"]).
    Stdlib only (`subprocess`); imported lazily so the pure core never pulls it
    in. This is the ONLY function in the module that touches the network, and it
    is injectable so tests substitute a fake (no-network) runner.

    Before shelling out, the argv passes through `_validate_gh_argv`, an
    allowlist barrier on the gh subcommand (argument-injection control). A
    validation failure returns a non-zero refusal tuple rather than raising, so
    the `(rc, stdout, stderr)` contract every caller branches on is preserved.
    """
    import subprocess
    try:
        argv = _validate_gh_argv(args)
    except ValueError as exc:
        return (2, "", "refusing to run gh: %s" % exc)
    try:
        proc = subprocess.run(
            ["gh"] + argv,
            input=input_text,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return (127, "", "gh executable not found on PATH")
    return (proc.returncode, proc.stdout, proc.stderr)


def _gh_auth_ok(run):
    """Return True iff `gh auth status` succeeds (rc 0). No mutation."""
    rc, _out, _err = run(["auth", "status"])
    return rc == 0


def _graphql(run, query):
    """Run a `gh api graphql -f query=...` call; return parsed JSON or raise.

    Raises InputError on a non-zero gh exit or unparseable response. Used for the
    node-id lookup, the type set, and the link step.
    """
    rc, out, err = run(["api", "graphql", "-f", "query=" + query])
    if rc != 0:
        raise InputError("gh graphql call failed (rc=%d): %s"
                         % (rc, (err or out or "").strip()))
    try:
        return json.loads(out) if out.strip() else {}
    except json.JSONDecodeError as exc:
        raise InputError("gh graphql returned unparseable JSON: %s" % exc)


def _resolve_issue_node_id(run, owner, name, number):
    """Resolve a created issue's GraphQL node id from its number.

    `number` can originate from the stdin envelope (a `tracker.ref` /
    `blocked_by_refs` entry), so it is reduced to a safe character set before
    being interpolated into the GraphQL query string (CWE-78).
    """
    number = _safe_gh_value(number, "issue number")
    query = (
        'query { repository(owner: "%s", name: "%s") { issue(number: %s) { id } } }'
        % (owner, name, number))
    data = _graphql(run, query)
    node_id = (((data.get("data") or {}).get("repository") or {})
               .get("issue") or {}).get("id")
    if not node_id:
        raise InputError(
            "could not resolve node id for issue #%s in %s/%s"
            % (number, owner, name))
    return node_id


def _issue_type_ids(run, owner, name):
    """Return {lowercased native type name: type node id} for the repo.

    Reads the repo's enabled `issueTypes`. An empty/failed result is returned as
    an empty dict so the caller skips type setting and warns (never crashes),
    matching the gh-cli-recipes degradation.
    """
    query = (
        'query { repository(owner: "%s", name: "%s") { '
        'issueTypes(first: 50) { nodes { id name isEnabled } } } }'
        % (owner, name))
    try:
        data = _graphql(run, query)
    except InputError:
        return {}
    nodes = ((((data.get("data") or {}).get("repository") or {})
              .get("issueTypes") or {}).get("nodes") or [])
    return {n.get("name", "").lower(): n.get("id")
            for n in nodes
            if n.get("isEnabled") and n.get("id") and n.get("name")}


def _safe_gh_value(value, what):
    """Return `value` rebuilt from per-character allowlist-guarded characters.

    The few identifiers this module still interpolates into a gh command line or
    a GraphQL query string (the repo `owner`/`name`, an issue number, and a
    GraphQL node id) are each reassembled here from a closed character set. The
    `ch in (...)` membership test against the INLINE literal tuple is the control
    CodeQL recognises as a sanitizer (a constant-comparison barrier guard), and
    it is genuinely safe: a value composed solely of ASCII letters, digits and
    `. _ - / = +` cannot carry a quote, brace, parenthesis, whitespace, or
    option metacharacter into either sink (CWE-78/88). Every legitimate repo
    segment, issue number, and GitHub node id is already composed only of these
    characters, so the returned value is unchanged on every real call path; a
    value containing anything else is rejected rather than passed through.
    """
    rebuilt = []
    for ch in str(value):
        if ch in (
            "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
            "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
            "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
            "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
            "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
            ".", "_", "-", "/", "=", "+",
        ):
            rebuilt.append(ch)
        else:
            raise InputError(
                "%s contains a disallowed character: %r" % (what, value))
    return "".join(rebuilt)


def _split_repo(repo):
    """Split an `owner/name` string, raising InputError on a malformed value.

    The shape is enforced with `_REPO_RE` (strict owner/name) and then reduced to
    a safe character set with `_safe_gh_value`: `repo` is interpolated into the
    gh REST endpoint path and into GraphQL queries, so this is the sanitizer that
    keeps a user-provided value from carrying option/shell/whitespace
    metacharacters into either sink (CWE-78/88).
    """
    if not isinstance(repo, str) or not _REPO_RE.match(repo):
        raise InputError("repo must be in owner/name form, got %r" % repo)
    return _safe_gh_value(repo, "repo").split("/", 1)


def file_unit(unit, repo, run=None, retry_links_only=False):
    """File one work unit through the GitHub tracker seam; return a TrackerBlock.

    The single GitHub-only mutation boundary (WUAAVG-FR-010). The sequence is:

      1. `gh auth status` BEFORE any mutation. Unauthenticated/unavailable ->
         InputError (exit 1) with an actionable message, stopping BEFORE any
         issue is filed (no partial file). (WUAAVG-TC-022)
      2. Create the issue (REST `gh api .../issues`); capture its number/url.
      3. Resolve the created issue's node id.
      4. Set the native Issue Type from `unit.type` via `updateIssueIssueType`.
         If the repo has no matching enabled native type, SKIP and warn (never
         crash; gh-cli-recipes skip-and-warn fallback, covers spike->Task).
      5. As a SEPARATE retryable step, add the blocking links from
         `tracker.blocked_by_refs` via `addBlockedBy`. A failure HERE (after the
         issue exists) raises TrackerError carrying the PARTIAL TrackerBlock
         (ref/url/node_id set, blocked_by_refs pending) so the caller can persist
         it and surface a link-only retry (WUAAVG-NFR-003).

    `run` is the injectable gh runner `(argv_after_gh, input_text=None) ->
    (rc, stdout, stderr)`; it defaults to the real subprocess-based `_gh_runner`.
    Tests pass a FAKE runner so they never touch the network (NFR-002/-NFR-005).

    `retry_links_only=True` is the link-only retry path: the unit already carries
    a `tracker` block with a `ref` (the issue exists), so steps 2-4 are SKIPPED
    and only the blocking links are (re)applied. No duplicate issue is created.

    Loud degradation, all non-zero exit + a message, never a silent no-op:
      * gh unauthenticated/unavailable -> InputError, stop before any file.
      * `tracker.system` 'ghe'/'jira' (reserved) -> InputError "not implemented".
    A schema-invalid unit is the caller's responsibility (validate_structural
    upstream); this seam files only what it is handed.

    Returns the complete TrackerBlock dict:
    `{system, ref, url, node_id?, db_id?, blocked_by_refs[]}`.
    """
    if run is None:
        run = _gh_runner

    if not isinstance(unit, dict):
        raise InputError("file_unit expects a unit dict, got %s"
                         % type(unit).__name__)

    tracker = unit.get("tracker") if isinstance(unit.get("tracker"), dict) else {}
    system = tracker.get("system", "github")

    # Reserved-but-unimplemented systems degrade loudly (never a silent no-op).
    if system in RESERVED_TRACKER_SYSTEMS:
        raise InputError(
            "tracker.system %r is reserved but not implemented: only %s is "
            "supported today (no issue was filed)."
            % (system, "/".join(IMPLEMENTED_TRACKER_SYSTEMS)))
    if system not in IMPLEMENTED_TRACKER_SYSTEMS:
        raise InputError(
            "tracker.system %r is not a known tracker (expected one of %s)."
            % (system, "/".join(IMPLEMENTED_TRACKER_SYSTEMS + RESERVED_TRACKER_SYSTEMS)))

    owner, name = _split_repo(repo)
    blocked_by_refs = list(tracker.get("blocked_by_refs") or [])

    # --- Guard: auth BEFORE any mutation (TC-022). No partial file on failure. ---
    if not _gh_auth_ok(run):
        raise InputError(
            "gh is not authenticated or unavailable: run `gh auth login` and "
            "retry. No issue was filed (work-units.json is unchanged).")

    # --- Link-only retry: the issue already exists; (re)apply blocking links. ---
    if retry_links_only:
        ref = tracker.get("ref")
        node_id = tracker.get("node_id")
        if not ref:
            raise InputError(
                "link-only retry needs an existing tracker.ref, but unit %r has "
                "none (nothing to retry; file it first)." % unit.get("id"))
        # A stdin-supplied node id is interpolated into GraphQL mutations, so
        # reduce it to a safe character set; otherwise resolve it from the ref.
        # The if/else (rather than two separate ifs) keeps every path assigning a
        # sanitized-or-resolved value, never the raw stdin one (CWE-78).
        if node_id:
            node_id = _safe_gh_value(node_id, "node id")
        else:
            node_id = _resolve_issue_node_id(run, owner, name, ref)
        block = {
            "system": "github",
            "ref": str(ref),
            "url": tracker.get("url") or _issue_url(owner, name, ref),
            "node_id": node_id,
            "blocked_by_refs": [],
        }
        if tracker.get("db_id") is not None:
            block["db_id"] = tracker["db_id"]
        _add_blocking_links(run, owner, name, node_id, ref, blocked_by_refs, block)
        return block

    # --- Step 2: create the issue. ---
    number, url = _create_issue(run, repo, unit)

    # --- Step 3: resolve node id. ---
    node_id = _resolve_issue_node_id(run, owner, name, number)

    block = {
        "system": "github",
        "ref": str(number),
        "url": url,
        "node_id": node_id,
        "blocked_by_refs": [],
    }

    # --- Step 4: set the native Issue Type (skip-and-warn if absent). ---
    _set_issue_type(run, owner, name, node_id, unit.get("type"))

    # --- Step 5: SEPARATE retryable link step (partial-state on failure). ---
    _add_blocking_links(run, owner, name, node_id, number, blocked_by_refs, block)

    return block


def _issue_url(owner, name, number):
    return "https://github.com/%s/%s/issues/%s" % (owner, name, number)


def _create_issue(run, repo, unit):
    """Create the issue via the GitHub REST API; return (number, url).

    The body is the inline projection of `description`/`acceptance_criteria`
    (R5). The user-controlled fields (title, body, labels) are delivered as a
    JSON request body on STDIN, never on the command line: gh's argv carries only
    the static method/endpoint plus the sanitized `owner`/`name`, so no
    user-provided value can reach the command line (CWE-78/88). `gh issue create`
    has no way to take the title off argv, so the REST form (`gh api .../issues`)
    is used; it returns the created issue as JSON, from which number/url are read.
    """
    owner, name = _split_repo(repo)
    title = unit.get("title") or unit.get("id") or "Untitled work unit"
    body = _render_body(unit)
    labels = [x for x in (unit.get("labels") or []) if isinstance(x, str) and x]
    payload = json.dumps({"title": title, "body": body, "labels": labels})
    endpoint = "repos/" + owner + "/" + name + "/issues"
    rc, out, err = run(["api", "--method=POST", endpoint, "--input=-"],
                       input_text=payload)
    if rc != 0:
        raise InputError(
            "creating the issue (gh api POST .../issues) failed (rc=%d): %s "
            "(no issue filed)." % (rc, (err or out or "").strip()))
    try:
        data = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        raise InputError(
            "gh api issue create did not return parseable JSON: %r" % out)
    number = data.get("number")
    url = data.get("html_url") or ""
    if not isinstance(number, int):
        raise InputError(
            "gh api issue create returned no issue number: %r" % out)
    return str(number), url


def _render_body(unit):
    """Project `description` + `acceptance_criteria` into the issue body (R5)."""
    lines = []
    desc = unit.get("description")
    if desc:
        lines += ["## Objective", "", str(desc), ""]
    ac = unit.get("acceptance_criteria") or []
    if ac:
        lines += ["## Acceptance Criteria", ""]
        lines += ["- [ ] %s" % c for c in ac]
        lines += [""]
    return "\n".join(lines).rstrip() + "\n"


def _set_issue_type(run, owner, name, issue_node_id, unit_type):
    """Set the native Issue Type from `unit_type`; SKIP and warn if unavailable.

    Maps via TYPE_TO_NATIVE, looks the native type up in the repo's enabled
    issueTypes, and runs `updateIssueIssueType`. If the repo has no matching
    enabled type (or the issueTypes query is empty/disabled), logs a warning and
    returns WITHOUT setting a type (gh-cli-recipes skip-and-warn; this is the
    documented spike->Task fallback path). Never crashes; never invents a type.
    """
    native = TYPE_TO_NATIVE.get(unit_type)
    if native is None:
        log("warning: work-unit type %r has no native mapping; skipping type set"
            % unit_type)
        return
    type_ids = _issue_type_ids(run, owner, name)
    type_node_id = type_ids.get(native.lower())
    if not type_node_id:
        log("warning: native Issue Type %r is not enabled/available in %s/%s; "
            "skipping type set for this issue (gh-cli-recipes skip-and-warn)."
            % (native, owner, name))
        return
    query = (
        'mutation { updateIssueIssueType(input: { issueId: "%s", '
        'issueTypeId: "%s" }) { issue { id issueType { name } } } }'
        % (issue_node_id, type_node_id))
    _graphql(run, query)


def _add_blocking_links(run, owner, name, issue_node_id, number,
                        blocked_by_refs, block):
    """Add each `blocked_by_ref` via `addBlockedBy`; TrackerError on failure.

    The SEPARATE retryable step (WUAAVG-NFR-003). Each blocking ref is resolved
    to its node id and linked. On the FIRST failure, raises TrackerError carrying
    the partial `block` (ref/url/node_id set, `blocked_by_refs` holding only the
    links applied so far) plus the still-pending refs, so the caller persists the
    partial state and offers a link-only retry. Records every successfully-linked
    ref into `block["blocked_by_refs"]` as it goes.
    """
    applied = []
    for i, blocker_ref in enumerate(blocked_by_refs):
        try:
            blocker_node = _resolve_issue_node_id(run, owner, name, blocker_ref)
            query = (
                'mutation { addBlockedBy(input: { issueId: "%s", '
                'blockingIssueId: "%s" }) { issue { id } blockingIssue { id } } }'
                % (issue_node_id, blocker_node))
            _graphql(run, query)
            applied.append(str(blocker_ref))
        except InputError as exc:
            block["blocked_by_refs"] = applied
            pending = [str(r) for r in blocked_by_refs[i:]]
            raise TrackerError(
                "issue #%s was created (ref recorded) but adding blocking "
                "link(s) %s failed: %s. The partial tracker block is persisted "
                "(ref set, blocked_by_refs pending). Re-run the seam in "
                "link-only retry mode (file-unit --retry-links-only) to finish "
                "the links without creating a duplicate issue."
                % (number, ", ".join(pending), exc),
                partial=block)
    block["blocked_by_refs"] = applied
    return block


# --------------------------------------------------------------------------
# CLI entry points
# --------------------------------------------------------------------------

def _read_stdin_json():
    """Read and parse a JSON envelope from stdin, raising InputError on failure."""
    raw = sys.stdin.read()
    if not raw.strip():
        raise InputError("expected a JSON envelope on stdin, got empty input")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InputError("stdin is not valid JSON: %s" % exc)


def cmd_load(spec_dir):
    return load(spec_dir)


def cmd_write(spec_dir):
    envelope = _read_stdin_json()
    path = write_envelope(spec_dir, envelope)
    return {"written": path, "source": WORK_UNITS_NAME}


def cmd_validate():
    envelope = _read_stdin_json()
    validate_structural(envelope)
    return {"ok": True}


def _units_from_stdin():
    """Read a units list from stdin: a bare list OR an envelope carrying `units`."""
    doc = _read_stdin_json()
    if isinstance(doc, list):
        return [u for u in doc if isinstance(u, dict)]
    if isinstance(doc, dict) and isinstance(doc.get("units"), list):
        return [u for u in doc["units"] if isinstance(u, dict)]
    raise InputError(
        "expected a units list or an envelope carrying `units` on stdin")


def _test_cases_from_stdin():
    """Read a test-cases list from stdin: a bare list OR a doc carrying `cases`."""
    doc = _read_stdin_json()
    if isinstance(doc, list):
        return [c for c in doc if isinstance(c, dict)]
    if isinstance(doc, dict) and isinstance(doc.get("cases"), list):
        return [c for c in doc["cases"] if isinstance(c, dict)]
    raise InputError(
        "expected a test-cases list or a doc carrying `cases` on stdin")


def cmd_project():
    units = _units_from_stdin()
    return {"units": project_blocked_by(units)}


def cmd_gate_dedup(gating_set_ids):
    units = _units_from_stdin()
    return gate_dedup(units, gating_set_ids)


def cmd_gating_set(batch):
    cases = _test_cases_from_stdin()
    return {"gating_set": gating_set(cases, batch)}


def cmd_drift_report(spec_dir, test_results_path):
    return drift_report(spec_dir, test_results_path)


def cmd_file_unit(repo, retry_links_only):
    """File one unit (read from stdin) through the GitHub tracker seam.

    Reads a single WorkUnit (a bare unit dict, or an envelope/list from which the
    first unit is taken) on stdin, files it via `file_unit`, and emits the
    resulting TrackerBlock. On a link-step failure AFTER issue creation, prints
    the PARTIAL tracker block to stdout (so the caller can persist it) and returns
    a non-zero exit (handled in `main`), never a silent success (WUAAVG-NFR-003).
    """
    doc = _read_stdin_json()
    if isinstance(doc, dict) and isinstance(doc.get("units"), list):
        units = [u for u in doc["units"] if isinstance(u, dict)]
        unit = units[0] if units else None
    elif isinstance(doc, list):
        unit = next((u for u in doc if isinstance(u, dict)), None)
    elif isinstance(doc, dict):
        unit = doc
    else:
        unit = None
    if unit is None:
        raise InputError("expected a work unit (or envelope/list) on stdin")
    block = file_unit(unit, repo, retry_links_only=retry_links_only)
    return {"tracker": block}


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------

def _selftest():
    """Exercise load / validate / write over inline fixtures. 0 pass, 1 fail."""
    import shutil

    failures = []

    def check(label, got, want):
        if got != want:
            failures.append("%s:\n  got:  %r\n  want: %r" % (label, got, want))

    def check_raises(label, fn):
        try:
            fn()
        except InputError:
            return
        failures.append("%s: expected InputError, none raised" % label)

    valid_envelope = {
        "$schema": "https://roubo.dev/schema/work-units/v1.0.0.json",
        "schemaVersion": "1.0.0",
        "specSlug": "demo",
        "units": [
            {
                "id": "WU-001", "title": "A unit", "type": "feature",
                "description": "do a thing",
                "acceptance_criteria": ["it works"],
                "depends_on": [],
                "implements": {"requirement_ids": [], "user_story_ids": [],
                               "test_case_ids": []},
            },
        ],
    }

    # --- validate_structural pass ---
    check("validate pass", validate_structural(valid_envelope), True)

    # --- validate_structural failures ---
    check_raises("missing envelope key",
                 lambda: validate_structural({"schemaVersion": "1.0.0",
                                              "specSlug": "x", "units": []}))
    check_raises("wrong schemaVersion", lambda: validate_structural(
        {**valid_envelope, "schemaVersion": "2.0.0"}))
    check_raises("bad unit type", lambda: validate_structural(
        {**valid_envelope, "units": [{"id": "WU-002", "title": "t",
                                      "type": "epic", "description": "d",
                                      "acceptance_criteria": []}]}))
    check_raises("missing unit field", lambda: validate_structural(
        {**valid_envelope, "units": [{"id": "WU-003"}]}))

    work = tempfile.mkdtemp(prefix="work-units-selftest-")
    try:
        spec_a = os.path.join(work, "spec-a")
        os.makedirs(spec_a)

        # --- load: work-units.json shape ---
        _atomic_write_json(os.path.join(spec_a, WORK_UNITS_NAME), valid_envelope)
        got = load(spec_a)
        check("load source is work-units.json", got["source"], WORK_UNITS_NAME)
        check("load units count", len(got["units"]), 1)

        # --- load: issues.json fallback (bare list + wrapper) ---
        spec_b = os.path.join(work, "spec-b")
        os.makedirs(spec_b)
        _atomic_write_json(os.path.join(spec_b, ISSUES_NAME),
                           [{"number": 1}, {"number": 2}])
        gb = load(spec_b)
        check("load fallback source", gb["source"], ISSUES_NAME)
        check("load fallback bare-list count", len(gb["units"]), 2)

        spec_c = os.path.join(work, "spec-c")
        os.makedirs(spec_c)
        _atomic_write_json(os.path.join(spec_c, ISSUES_NAME),
                           {"issues": [{"number": 9}]})
        check("load fallback wrapper count", len(load(spec_c)["units"]), 1)

        # --- load: prefers work-units.json when both present ---
        spec_d = os.path.join(work, "spec-d")
        os.makedirs(spec_d)
        _atomic_write_json(os.path.join(spec_d, WORK_UNITS_NAME), valid_envelope)
        _atomic_write_json(os.path.join(spec_d, ISSUES_NAME), [{"number": 1}])
        check("load prefers work-units.json", load(spec_d)["source"],
              WORK_UNITS_NAME)

        # --- load: neither file -> loud fail (never empty-set success) ---
        spec_e = os.path.join(work, "spec-e")
        os.makedirs(spec_e)
        check_raises("neither-file loud fail", lambda: load(spec_e))

        # --- write_envelope: round-trip + atomic ---
        spec_w = os.path.join(work, "spec-w")
        os.makedirs(spec_w)
        write_envelope(spec_w, valid_envelope)
        round_tripped = load(spec_w)
        check("write round-trip source", round_tripped["source"],
              WORK_UNITS_NAME)
        check("write round-trip units", len(round_tripped["units"]), 1)

        # --- write_envelope: never deletes/overwrites issues.json ---
        spec_x = os.path.join(work, "spec-x")
        os.makedirs(spec_x)
        issues_p = os.path.join(spec_x, ISSUES_NAME)
        _atomic_write_json(issues_p, [{"number": 7}])
        with open(issues_p, encoding="utf-8") as f:
            before = f.read()
        write_envelope(spec_x, valid_envelope)
        with open(issues_p, encoding="utf-8") as f:
            after = f.read()
        check("issues.json untouched by write", before, after)
        check("issues.json still present", os.path.isfile(issues_p), True)

        # --- write_envelope: refuses an invalid envelope (nothing written) ---
        spec_inv = os.path.join(work, "spec-inv")
        os.makedirs(spec_inv)
        check_raises("write refuses invalid envelope",
                     lambda: write_envelope(spec_inv, {"units": []}))
        check("nothing written on invalid",
              os.path.isfile(os.path.join(spec_inv, WORK_UNITS_NAME)), False)

        # --- path-escape refusal (a sibling dir outside the spec dir) ---
        outside = os.path.join(work, "outside")
        os.makedirs(outside)
        check_raises("path-escape refusal", lambda: _resolve_in_dir(
            spec_w, os.path.join("..", "outside", "x.json")))

        # --- read-side confinement barrier (py/path-injection, CWE-22) ---
        # The same realpath + containment control now guards the read path.
        # A `..` traversal, an absolute path, and a symlinked dir pointing out
        # are all refused; an in-tree relative name resolves cleanly.
        check_raises("read traversal refusal", lambda: _confine(
            spec_w, os.path.join("..", "outside", "x.json"), verb="read"))
        check_raises("read absolute-path refusal", lambda: _confine(
            spec_w, os.path.join(outside, "x.json"), verb="read"))
        escape_link = os.path.join(spec_w, "escape")
        os.symlink(outside, escape_link)
        check_raises("read symlink-escape refusal", lambda: _confine(
            spec_w, os.path.join("escape", "x.json"), verb="read"))
        os.unlink(escape_link)
        in_tree = _confine(spec_w, TEST_RESULTS_NAME, verb="read")
        check("read in-tree name stays under dir",
              in_tree.startswith(os.path.realpath(spec_w) + os.sep), True)

        # --- drift_report: an escaping --test-results path is refused before
        # any os.path.isfile / open touches the filesystem ---
        check_raises("drift refuses escaping test-results",
                     lambda: drift_report(
                         spec_a, os.path.join("..", "outside", "passwd")))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    # ----------------------------------------------------------------------
    # Core II fixtures: project_blocked_by / gate_dedup / gating_set
    # ----------------------------------------------------------------------

    # --- project_blocked_by: topo order + blocked_by_refs regenerated ---
    # B depends_on A; input order is [B, A] so the topo sort must reorder to A,B.
    proj_units = [
        {"id": "WU-002", "depends_on": ["WU-001"],
         "tracker": {"system": "github", "ref": "420",
                     "blocked_by_refs": ["#9999"]}},
        {"id": "WU-001", "depends_on": [],
         "tracker": {"system": "github", "ref": "406", "blocked_by_refs": []}},
    ]
    projected = project_blocked_by(proj_units)
    check("project topo order", [u["id"] for u in projected],
          ["WU-001", "WU-002"])
    # B's hand-edited blocked_by_refs is overwritten with A's tracker.ref.
    b = next(u for u in projected if u["id"] == "WU-002")
    check("project blocked_by_refs regenerated", b["tracker"]["blocked_by_refs"],
          ["406"])
    # Inputs are not mutated.
    check("project does not mutate input", proj_units[0]["tracker"]
          ["blocked_by_refs"], ["#9999"])

    # --- project_blocked_by: blocker with no tracker.ref yet -> graceful skip ---
    proj_unfiled = [
        {"id": "WU-011", "depends_on": []},  # not filed: no tracker
        {"id": "WU-012", "depends_on": ["WU-011"],
         "tracker": {"system": "github", "ref": "10", "blocked_by_refs": []}},
    ]
    pf = project_blocked_by(proj_unfiled)
    pf_b = next(u for u in pf if u["id"] == "WU-012")
    check("project unfiled blocker skipped", pf_b["tracker"]["blocked_by_refs"],
          [])

    # --- project_blocked_by: cycle -> InputError (exit 1) ---
    check_raises("project rejects cycle", lambda: project_blocked_by([
        {"id": "WU-021", "depends_on": ["WU-022"]},
        {"id": "WU-022", "depends_on": ["WU-021"]},
    ]))

    # --- gate_dedup: exact set-equality, order-independent ---
    gate_units = [
        {"id": "WU-100", "kind": "verify", "labels": ["P0", "verify"],
         "implements": {"test_case_ids": ["TC-003", "TC-001", "TC-002"]}},
        {"id": "WU-101", "kind": None, "labels": [],
         "implements": {"test_case_ids": []}},
    ]
    dd = gate_dedup(gate_units, ["TC-001", "TC-002", "TC-003"])
    check("gate_dedup present (order-independent)", dd,
          {"already_present": True, "existing_id": "WU-100"})
    dd_miss = gate_dedup(gate_units, ["TC-001", "TC-002"])
    check("gate_dedup absent on different set", dd_miss,
          {"already_present": False, "existing_id": None})
    # Missing the verify label -> not a match even with the right set.
    no_label = [{"id": "WU-110", "kind": "verify", "labels": ["P0"],
                 "implements": {"test_case_ids": ["TC-001"]}}]
    check("gate_dedup needs verify label",
          gate_dedup(no_label, ["TC-001"])["already_present"], False)

    # --- gating_set: L1/L2 + e2e_flow; L3/L4 excluded ---
    cases = [
        {"id": "TC-001", "level": 1, "type": "functional"},
        {"id": "TC-002", "level": 2, "type": "negative"},
        {"id": "TC-003", "level": 3, "type": "edge_case"},
        {"id": "TC-004", "level": 4, "type": "performance"},
        {"id": "TC-005", "level": 4, "type": "e2e_flow"},  # gates via type
    ]
    check("gating_set L1/L2 + e2e_flow, L3/L4 excluded",
          gating_set(cases), ["TC-001", "TC-002", "TC-005"])
    # Batch scoping: only TC-001 and TC-005 are in this batch.
    check("gating_set batch-scoped",
          gating_set(cases, ["TC-001", "TC-005", "TC-003"]),
          ["TC-001", "TC-005"])

    # ----------------------------------------------------------------------
    # drift_report fixtures (WUAAVG-FR-014/-FR-015): report-only, no auto-fix.
    # ----------------------------------------------------------------------
    drift_work = tempfile.mkdtemp(prefix="wu-drift-selftest-")
    try:
        # Absent test-results.json -> clean skip (empty report + note).
        sk = os.path.join(drift_work, "skip")
        os.makedirs(sk)
        _atomic_write_json(os.path.join(sk, WORK_UNITS_NAME), valid_envelope)
        _atomic_write_json(os.path.join(sk, TEST_CASES_NAME), {"cases": cases})
        rep_skip = drift_report(sk)
        check("drift absent-results skipped", rep_skip["skipped"], True)
        check("drift absent-results empty gating", rep_skip["gating_set_drift"], [])

        # Full diverged folder: gating-set drift + stale gate + orphaned result.
        dv = os.path.join(drift_work, "diverged")
        os.makedirs(dv)
        dv_cases = [
            {"id": "TC-001", "level": 1, "type": "functional"},
            {"id": "TC-002", "level": 2, "type": "negative"},
            {"id": "TC-003", "level": 1, "type": "functional"},
        ]
        dv_env = {
            "$schema": "x", "schemaVersion": "1.0.0", "specSlug": "dv",
            "units": [
                {"id": "WU-001", "title": "slice", "type": "task",
                 "description": "d", "acceptance_criteria": ["a"],
                 "implements": {"test_case_ids": ["TC-001", "TC-002", "TC-003"]}},
                {"id": "WU-002", "title": "gate", "type": "task",
                 "kind": "verify", "labels": ["P0", "verify"],
                 "description": "d", "acceptance_criteria": ["a"],
                 "depends_on": ["WU-001"],
                 "implements": {"test_case_ids": ["TC-001", "TC-002"]}},
            ],
        }
        _atomic_write_json(os.path.join(dv, WORK_UNITS_NAME), dv_env)
        _atomic_write_json(os.path.join(dv, TEST_CASES_NAME), {"cases": dv_cases})
        _atomic_write_json(os.path.join(dv, TEST_RESULTS_NAME), {
            "planHash": "stale-does-not-match",
            "caseResults": [{"id": "TC-001", "derivedStatus": "passed"},
                            {"id": "TC-099", "derivedStatus": "passed"}],
        })
        rep = drift_report(dv)
        check("drift gating-set drift count", len(rep["gating_set_drift"]), 1)
        check("drift gating-set missing TC-003",
              rep["gating_set_drift"][0]["missing_from_gate"], ["TC-003"])
        check("drift stale gate count", len(rep["stale_gates"]), 1)
        check("drift orphaned result TC-099",
              [o["test_case_id"] for o in rep["orphaned_results"]], ["TC-099"])

        # No-drift folder: gate set exactly equals the batch gating set, plan
        # matches, no orphan.
        nd = os.path.join(drift_work, "nodrift")
        os.makedirs(nd)
        nd_env = {
            "$schema": "x", "schemaVersion": "1.0.0", "specSlug": "nd",
            "units": [
                {"id": "WU-001", "title": "slice", "type": "task",
                 "description": "d", "acceptance_criteria": ["a"],
                 "implements": {"test_case_ids": ["TC-001", "TC-002", "TC-003"]}},
                {"id": "WU-002", "title": "gate", "type": "task",
                 "kind": "verify", "labels": ["P0", "verify"],
                 "description": "d", "acceptance_criteria": ["a"],
                 "depends_on": ["WU-001"],
                 "implements": {"test_case_ids": ["TC-001", "TC-002", "TC-003"]}},
            ],
        }
        _atomic_write_json(os.path.join(nd, WORK_UNITS_NAME), nd_env)
        _atomic_write_json(os.path.join(nd, TEST_CASES_NAME), {"cases": dv_cases})
        _atomic_write_json(os.path.join(nd, TEST_RESULTS_NAME), {
            "planHash": _plan_hash(dv_cases),
            "caseResults": [{"id": "TC-001"}, {"id": "TC-002"}, {"id": "TC-003"}],
        })
        rep_nd = drift_report(nd)
        check("drift no-drift gating", rep_nd["gating_set_drift"], [])
        check("drift no-drift stale", rep_nd["stale_gates"], [])
        check("drift no-drift orphaned", rep_nd["orphaned_results"], [])
    finally:
        shutil.rmtree(drift_work, ignore_errors=True)

    # ----------------------------------------------------------------------
    # Tracker seam fixtures: file_unit with a FAKE gh runner (no network).
    # ----------------------------------------------------------------------

    def fake_runner(responses):
        """Build a fake gh runner that replies to a fixed sequence of calls.

        `responses` maps a matcher predicate over the argv to (rc, out, err).
        Falls through to a generic graphql-success for unmatched graphql calls.
        """
        def run(args, input_text=None):
            for matches, reply in responses:
                if matches(args):
                    return reply
            return (0, "{}", "")
        return run

    feature_unit = {
        "id": "WU-001", "title": "A feature", "type": "feature",
        "description": "do it", "acceptance_criteria": ["works"],
        "tracker": {"system": "github", "blocked_by_refs": []},
    }

    def gql_with(*needles):
        return lambda a: a[:2] == ["api", "graphql"] and all(
            n in (a[-1] if a else "") for n in needles)

    # The REST issue-create call: `gh api --method=POST repos/.../issues
    # --input=-` (user fields ride on stdin, not argv).
    def is_create(a):
        return a[:2] == ["api", "--method=POST"]

    # Happy path: auth ok, create -> node id -> type set -> (no links).
    happy = fake_runner([
        (lambda a: a[:2] == ["auth", "status"], (0, "ok", "")),
        (is_create,
         (0, json.dumps({"number": 42,
                         "html_url": "https://github.com/o/r/issues/42"}), "")),
        (gql_with("issueTypes"),
         (0, json.dumps({"data": {"repository": {"issueTypes": {"nodes": [
             {"id": "IT_feat", "name": "Feature", "isEnabled": True}]}}}}), "")),
        (gql_with("issue(number"),
         (0, json.dumps({"data": {"repository": {"issue": {"id": "ND_42"}}}}), "")),
    ])
    blk = file_unit(feature_unit, "o/r", run=happy)
    check("seam happy ref", blk["ref"], "42")
    check("seam happy system", blk["system"], "github")
    check("seam happy node_id", blk["node_id"], "ND_42")
    check("seam happy blocked_by_refs empty", blk["blocked_by_refs"], [])

    # Auth failure stops BEFORE any create (no issue filed).
    filed = {"created": False}

    def auth_fail_run(args, input_text=None):
        if args[:2] == ["auth", "status"]:
            return (1, "", "not logged in")
        if is_create(args):
            filed["created"] = True
        return (0, "{}", "")
    check_raises("seam auth-fail raises",
                 lambda: file_unit(feature_unit, "o/r", run=auth_fail_run))
    check("seam auth-fail filed nothing", filed["created"], False)

    # Reserved tracker.system degrades loudly.
    ghe_unit = dict(feature_unit, tracker={"system": "ghe",
                                           "blocked_by_refs": []})
    check_raises("seam ghe reserved degrades",
                 lambda: file_unit(ghe_unit, "o/r", run=happy))

    # Link-step failure after create -> TrackerError with a partial block.
    dep_unit = {
        "id": "WU-010", "title": "Dep", "type": "task",
        "description": "d", "acceptance_criteria": ["ac"],
        "tracker": {"system": "github", "blocked_by_refs": ["101"]},
    }

    def link_fail_run(args, input_text=None):
        q = args[-1] if args else ""
        if args[:2] == ["auth", "status"]:
            return (0, "ok", "")
        if is_create(args):
            return (0, json.dumps({"number": 55,
                    "html_url": "https://github.com/o/r/issues/55"}), "")
        if "issueTypes" in q:
            return (0, json.dumps({"data": {"repository": {"issueTypes":
                    {"nodes": [{"id": "IT_task", "name": "Task",
                                "isEnabled": True}]}}}}), "")
        if "issue(number: 55" in q:
            return (0, json.dumps({"data": {"repository":
                    {"issue": {"id": "ND_55"}}}}), "")
        if "issue(number: 101" in q:
            return (0, json.dumps({"data": {"repository":
                    {"issue": {"id": "ND_101"}}}}), "")
        if "addBlockedBy" in q:
            return (1, "", "link mutation failed")
        return (0, "{}", "")
    try:
        file_unit(dep_unit, "o/r", run=link_fail_run)
        failures.append("seam link-fail: expected TrackerError, none raised")
    except TrackerError as exc:
        check("seam link-fail partial ref", exc.partial["ref"], "55")
        check("seam link-fail partial pending refs",
              exc.partial["blocked_by_refs"], [])

    # --- _gh_runner argv barrier (CWE-78/88) ---
    # The barrier sits on the WHOLE argv: a disallowed subcommand (argv[0]) AND a
    # dash-leading token that is not one of the hardcoded flags this module emits
    # are both refused with a non-zero tuple and NO subprocess invocation; the
    # legitimate call shapes (auth, the `-f query=` graphql shape, and the REST
    # create shape with its joined `--method=`/`--input=` flags) pass through to
    # the (faked) sink.
    import subprocess as _subprocess
    real_run = _subprocess.run
    sink_calls = []

    def fake_run(cmd, input=None, capture_output=False, text=False):
        sink_calls.append(cmd)

        class _Proc:
            returncode = 0
            stdout = "ok"
            stderr = ""
        return _Proc()

    _subprocess.run = fake_run
    try:
        rc, _o, err = _gh_runner(["rm", "-rf", "/"])
        check("gh barrier rejects disallowed rc", rc, 2)
        check("gh barrier rejects disallowed no-sink", sink_calls, [])
        if "disallowed gh subcommand" not in err:
            failures.append("gh barrier: expected refusal reason, got %r" % err)
        # An unexpected option token in argv[1:] is refused, with no sink.
        rc_inj, _oi, err_inj = _gh_runner(
            ["api", "--method=POST", "repos/o/r/issues", "--malicious-flag"])
        check("gh barrier rejects argv[1:] option-injection rc", rc_inj, 2)
        check("gh barrier rejects argv[1:] option-injection no-sink",
              sink_calls, [])
        if "disallowed option-shaped gh argument" not in err_inj:
            failures.append(
                "gh barrier: expected option-shape refusal, got %r" % err_inj)
        # Legitimate call shapes pass through to the (faked) sink unchanged.
        rc2, out2, _e = _gh_runner(["auth", "status"])
        check("gh barrier passthrough rc", rc2, 0)
        check("gh barrier passthrough out", out2, "ok")
        _gh_runner(["api", "graphql", "-f", "query={x}"])
        _gh_runner(["api", "--method=POST", "repos/o/r/issues", "--input=-"],
                   input_text="{}")
        check("gh barrier passthrough sink argv", sink_calls, [
            ["gh", "auth", "status"],
            ["gh", "api", "graphql", "-f", "query={x}"],
            ["gh", "api", "--method=POST", "repos/o/r/issues", "--input=-"],
        ])
    finally:
        _subprocess.run = real_run

    # --- _split_repo strict shape (sanitizes the repo taint) ---
    check("split_repo accepts owner/name", list(_split_repo("o/r")), ["o", "r"])
    check("split_repo accepts dotted/dashed",
          list(_split_repo("My-Org.x/repo_1")), ["My-Org.x", "repo_1"])
    check_raises("split_repo rejects option-shaped repo",
                 lambda: _split_repo("--repo=x"))
    check_raises("split_repo rejects whitespace repo",
                 lambda: _split_repo("o r/n"))
    check_raises("split_repo rejects missing name", lambda: _split_repo("owner"))

    # --- _safe_gh_value char-allowlist sanitizer (the recognised CWE-78 barrier)
    # Allowlisted values (repo segments, issue numbers, node ids) pass through
    # unchanged; anything carrying a metacharacter is rejected, not passed on.
    check("safe_gh_value passes node id", _safe_gh_value("I_kwDO-1=", "x"),
          "I_kwDO-1=")
    check("safe_gh_value passes number", _safe_gh_value(42, "x"), "42")
    check_raises("safe_gh_value rejects quote",
                 lambda: _safe_gh_value('a"b', "x"))
    check_raises("safe_gh_value rejects brace",
                 lambda: _safe_gh_value("a}b", "x"))
    check_raises("safe_gh_value rejects space",
                 lambda: _safe_gh_value("a b", "x"))

    if failures:
        log("selftest FAILED (%d):" % len(failures))
        for f in failures:
            log(f)
        return 1
    log("selftest OK")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="work_units.py",
        description="Stdlib core for the work-unit model (dual-read load, "
                    "envelope write, structural conformance, dependency "
                    "projection, verify-gate dedup, gating-set).",
    )
    p.add_argument("--selftest", action="store_true",
                   help="run inline fixtures and exit 0 on pass")
    sub = p.add_subparsers(dest="subcommand")

    ld = sub.add_parser("load", help="dual-read load -> {units, source}")
    ld.add_argument("--spec-dir", required=True, dest="spec_dir",
                    help="path to the .specifications/<slug>/ folder")

    wr = sub.add_parser("write", help="write work-units.json from stdin envelope")
    wr.add_argument("--spec-dir", required=True, dest="spec_dir",
                    help="path to the .specifications/<slug>/ folder")

    sub.add_parser("validate", help="structurally validate a stdin envelope")

    sub.add_parser("project",
                   help="topo-order units + regenerate blocked_by_refs (stdin)")

    gd = sub.add_parser("gate-dedup",
                        help="is a verify gate for --gating-set already present? "
                             "(reads stdin units)")
    gd.add_argument("--gating-set", required=True, dest="gating_set",
                    nargs="+", metavar="TC-ID",
                    help="the batch's gating TC ids (space-separated)")

    gs = sub.add_parser("gating-set",
                        help="compute a batch's L1/L2 + e2e_flow gating set "
                             "(reads stdin test cases)")
    gs.add_argument("--batch", dest="batch", nargs="*", default=None,
                    metavar="TC-ID",
                    help="scope membership to these TC ids (default: all)")

    dr = sub.add_parser(
        "drift-report",
        help="report-only results-aware drift over a spec folder "
             "(gating-set drift, stale gates, orphaned results); never auto-fixes")
    dr.add_argument("--spec-dir", required=True, dest="spec_dir",
                    help="path to the .specifications/<slug>/ folder")
    dr.add_argument("--test-results", dest="test_results_path", default=None,
                    metavar="PATH",
                    help="path to test-results.json (default: <spec-dir>/"
                         "test-results.json); absent => clean skip, exit 0")

    fu = sub.add_parser(
        "file-unit",
        help="file one stdin unit through the GitHub tracker seam "
             "(create -> set type -> add blocking links)")
    fu.add_argument("--repo", required=True, dest="repo", metavar="owner/name",
                    help="target GitHub repo")
    fu.add_argument("--retry-links-only", action="store_true",
                    dest="retry_links_only",
                    help="link-only retry: the issue already exists "
                         "(tracker.ref set); only (re)apply blocking links")

    return p, p.parse_args(argv)


def main(argv):
    parser, args = parse_args(argv)

    if args.selftest:
        return _selftest()

    if args.subcommand is None:
        parser.error("a subcommand is required (load, write, validate, project, "
                     "gate-dedup, gating-set, drift-report, file-unit) or use "
                     "--selftest")

    try:
        if args.subcommand == "load":
            result = cmd_load(args.spec_dir)
        elif args.subcommand == "write":
            result = cmd_write(args.spec_dir)
        elif args.subcommand == "validate":
            result = cmd_validate()
        elif args.subcommand == "project":
            result = cmd_project()
        elif args.subcommand == "gate-dedup":
            result = cmd_gate_dedup(args.gating_set)
        elif args.subcommand == "gating-set":
            result = cmd_gating_set(args.batch)
        elif args.subcommand == "drift-report":
            result = cmd_drift_report(args.spec_dir, args.test_results_path)
        elif args.subcommand == "file-unit":
            result = cmd_file_unit(args.repo, args.retry_links_only)
        else:  # pragma: no cover - argparse rejects unknown subcommands first
            parser.error("unknown subcommand: %s" % args.subcommand)
            return 2
    except TrackerError as exc:
        # Link-step failure AFTER issue creation (WUAAVG-NFR-003): persist the
        # PARTIAL tracker block to stdout, surface the link-only retry path on
        # stderr, and exit non-zero, never a silent success.
        log("work_units: %s" % exc)
        if exc.partial is not None:
            json.dump({"tracker": exc.partial, "partial": True}, sys.stdout,
                      indent=2)
            sys.stdout.write("\n")
        return 1
    except InputError as exc:
        log("work_units: %s" % exc)
        return 1

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
