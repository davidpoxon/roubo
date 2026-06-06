# TestBench prototype

A self-contained, `file://`-openable static prototype of the TestBench review surface, rendered strictly from the project's `DESIGN.md` tokens. Open `index.html` in a browser (no build, no server).

It demonstrates the three approved screens and the primary journeys:

- **Review tab** (the default view): two-pane master/detail. A case list grouped by level/priority with status indicators, a case detail pane with steps and expected observations, the segmented pass/fail mark control (marks update the derived per-case status and the progress rollup), the status override control, the slim segmented progress bar, the append-only notes rail, and the amber staleness banner with a reconcile dialog (removed cases become archived orphans, never deleted).
- **Create a TestBench**: the spec-picker modal with a discovered-specs list and a manual-path field showing its idle / valid / invalid validation states.
- **Settings**: the app-settings TestBench tab with the enable/disable toggle and its disabled-state hint.

Use the "Prototype views" switcher (top right) to move between the three screens. The layout reflows responsively (desktop two/three-pane, tablet collapses the notes rail, mobile drills list to detail). All data is mock; nothing is persisted and no network calls are made beyond the allowlisted web fonts.
