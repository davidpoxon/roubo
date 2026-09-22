import { useState } from "react";
import { Button, TextField, TextArea, Label } from "react-aria-components";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { FixIssueRecord } from "@roubo/shared";
import { useFileFixIssue } from "../../hooks/useGates";
import { ApiError } from "../../lib/api";

// Fix-issue filing panel (#735, VG-FR-009/VG-FR-010, VG-US-006; verify-gate VG-TC-045 /
// VG-TC-052 / VG-TC-053). Hosted in the batch surface, it opens when the selected
// gating case is failed: the operator captures failure notes and files a tracker
// issue wired to block the gate, so the gate stays not-passable until the fix
// issue is resolved.
//
// The filer is create-then-link. A 201 completes both steps; a 207 creates the
// issue but leaves the block-link pending. Both resolve as a SUCCESSFUL fetch
// (Response.ok spans 200-299) carrying the same FixIssueRecord, so this panel
// branches on `record.linkStatus`, never on a thrown error: `link_pending`
// surfaces an amber "Link step failed" warning plus a "Retry link only" action
// that re-files with `existingFixRef` set (the retry runs only the outstanding
// link step, never a duplicate create). A real failure (422 empty notes /
// capability absent, 409 no tracker / no integration, 400 path escape) rejects
// with an ApiError, surfaced inline (VG-FR-011, degrade loudly).
//
// Empty notes are rejected client-side BEFORE any call (VG-TC-053): the inline
// "notes required" message shows, no tracker call is made, no issue is created,
// and the gate state is unchanged.

interface FileFixIssuePanelProps {
  projectId: string;
  benchId: number;
  gateId: string;
  failedCaseId: string;
  // Invoked after a filing settles so the batch view refetches the subset plan
  // and re-reads the (still blocked) gate state.
  onFiled?: () => void;
}

export default function FileFixIssuePanel({
  projectId,
  benchId,
  gateId,
  failedCaseId,
  onFiled,
}: FileFixIssuePanelProps) {
  const [notes, setNotes] = useState("");
  const [record, setRecord] = useState<FixIssueRecord | null>(null);
  const [notesRequired, setNotesRequired] = useState(false);
  const fileFixIssue = useFileFixIssue(projectId, benchId, gateId);

  const trimmed = notes.trim();

  // Surface the server's degrade-loudly message for a real failure (422 / 409 /
  // 400). An ApiError carries the mapped message; any other error falls back to
  // its own message.
  const submitError =
    fileFixIssue.error instanceof ApiError
      ? fileFixIssue.error.message
      : fileFixIssue.error?.message;

  function file(existingFixRef?: string) {
    fileFixIssue.mutate(
      {
        failedCaseId,
        notes,
        ...(existingFixRef ? { existingFixRef } : {}),
      },
      {
        onSuccess: (rec) => setRecord(rec),
        onSettled: () => onFiled?.(),
      },
    );
  }

  function handleSubmit() {
    // Reject empty notes client-side before any tracker call (VG-TC-053): show the
    // inline required message and make NO request, so no issue is created and the
    // gate state is unchanged.
    if (trimmed.length === 0) {
      setNotesRequired(true);
      return;
    }
    setNotesRequired(false);
    file();
  }

  const linkPending = record?.linkStatus === "link_pending";
  const complete = record?.linkStatus === "complete";

  return (
    <section
      aria-label="File fix issue"
      className="shrink-0 rounded-lg ring-1 ring-inset ring-danger-border bg-danger-surface p-4"
    >
      <h3 className="text-14 font-semibold text-text-primary">Case {failedCaseId} failed</h3>
      <p className="mt-1 text-12 text-text-secondary">
        File a fix issue for this failure and block the gate until it is resolved.
      </p>

      {complete && record && (
        <div
          role="status"
          data-testid="fix-issue-confirmation"
          className="mt-3 flex items-start gap-2 rounded-lg border border-success-border bg-success-surface px-3 py-2 text-13 text-success-text"
        >
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Filed <span className="font-mono">{record.fixIssueRef}</span>. It now blocks {gateId} (
            <span className="font-mono">{record.gateRef}</span>). The gate stays blocked until the
            fix issue is resolved.
          </span>
        </div>
      )}

      {linkPending && record && (
        <div className="mt-3 flex flex-col gap-2">
          <div
            role="alert"
            data-testid="fix-issue-link-pending"
            className="flex items-start gap-2 rounded-lg border border-accent-border bg-accent-muted px-3 py-2 text-13 text-accent-text"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Link step failed: fix issue <span className="font-mono">{record.fixIssueRef}</span>{" "}
              was created, but it could not be registered as a blocker on {gateId}. The gate is not
              passable. Retry the link step.
            </span>
          </div>
          <div className="flex justify-end">
            <Button
              onPress={() => file(record.fixIssueRef)}
              isDisabled={fileFixIssue.isPending}
              className="rounded-control border border-border-strong bg-bg-surface px-3 py-1.5 text-13 font-medium text-text-body outline-none transition-colors not-disabled:hover:bg-bg-hover not-disabled:active:bg-bg-pressed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
            >
              {fileFixIssue.isPending ? "Retrying…" : "Retry link only"}
            </Button>
          </div>
          {submitError && (
            <p role="alert" className="text-12 text-danger-text">
              {submitError}
            </p>
          )}
        </div>
      )}

      {!complete && !linkPending && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <TextField
            value={notes}
            onChange={(value) => {
              setNotes(value);
              if (value.trim().length > 0) setNotesRequired(false);
            }}
            className="flex flex-col gap-1"
          >
            <Label className="text-12 font-medium text-text-secondary">Notes</Label>
            <TextArea
              rows={3}
              placeholder="Describe the failure"
              className="w-full resize-y rounded-control border border-border-control bg-bg-field px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:border-focus-ring focus:ring-2 focus:ring-focus-ring focus:ring-inset aria-[invalid=true]:border-danger data-[invalid]:border-danger"
            />
          </TextField>
          {notesRequired && (
            <p
              role="alert"
              data-testid="fix-issue-notes-required"
              className="text-12 text-danger-text"
            >
              Notes are required: describe the failure before filing.
            </p>
          )}
          {submitError && (
            <p role="alert" className="text-12 text-danger-text">
              {submitError}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              isDisabled={fileFixIssue.isPending}
              className="rounded-control border border-border-strong bg-bg-surface px-3 py-1.5 text-13 font-medium text-text-body outline-none transition-colors not-disabled:hover:bg-bg-hover not-disabled:active:bg-bg-pressed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
            >
              {fileFixIssue.isPending ? "Filing…" : "File fix issue & block gate"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
