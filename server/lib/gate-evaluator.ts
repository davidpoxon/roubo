// Re-export shim. The verify-gate evaluator moved to `shared/gate-evaluator.ts`
// so the shared delivery reducer can read a gate's state through the same
// function the server routes use (SB-FR-010); `shared/` cannot import from
// `server/lib`, so the function lives there and this module keeps every existing
// `server/lib/gate-evaluator` importer compiling unchanged.
export * from "@roubo/shared/gate-evaluator";
export type {
  GateEmptyReason,
  GateLifecycle,
  GateResults,
  GateState,
  GateStatus,
  VerifyUnit,
} from "@roubo/shared/gate-evaluator";
