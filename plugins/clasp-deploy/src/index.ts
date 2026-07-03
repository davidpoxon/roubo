import { componentHost, defineComponentPlugin } from "@roubo/plugin-sdk";
import { buildContract } from "./contract.js";

// Imperative (escape-hatch) component plugin with a one-shot deploy lifecycle.
// It models a "deploy" a declarative ProvisionDescriptor cannot express: the
// start hook queries the host for a capability, runs a single command to
// completion through the host broker, and reports `completed`. Every process
// handle is owned by the host; this plugin only drives the broker over
// JSON-RPC.
//
// The four hooks are all required (defineComponentPlugin rejects a partial
// imperative contract at validation time). `health` and `cleanup` keep the
// lifecycle whole so Stop -> cleanup -> ledger-clear has a real plugin side to
// observe. The lifecycle logic lives in `buildContract` so it is unit-testable
// against a mocked host.

defineComponentPlugin(buildContract(componentHost));
