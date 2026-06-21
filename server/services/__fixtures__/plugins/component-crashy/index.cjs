"use strict";

// Minimal component-kind plugin fixture that crashes on boot (issue #613). The
// supervisor sees an unexpected exit, fires the pre-restart cleanup hook, and
// after three crashes inside the window lands the plugin in `errored` with
// `restart-budget-exhausted`. Used to prove the hook fires on the way down and
// the budget logic is unchanged.
process.stderr.write("component-crashy: exiting with code 1\n");
process.exit(1);
