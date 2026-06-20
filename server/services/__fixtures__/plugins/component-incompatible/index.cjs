"use strict";

// This entry must never run: the manifest requires roubo ^2.0.0 while the host
// is 1.3.0, so the plugin is recorded as `incompatible` at discovery and is
// never spawned (issue #608). It exits non-zero to make an accidental spawn loud.
process.exit(1);
