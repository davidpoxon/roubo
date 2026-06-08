import { useState } from "react";
import { Button, TextField, TextArea, Label } from "react-aria-components";
import { AlertTriangle } from "lucide-react";
import type { CaseStatus, Note } from "@roubo/shared/testbench-contracts";
import { useAppendNote } from "../../hooks/useTestbenchNotes";
import { ApiError } from "../../lib/api";

// Append-only notes rail (#421, FR-011/FR-012, US-006). Renders a per-case
// timeline where every note is stamped author + timestamp + status-at-write,
// with no edit or delete affordance. Notes are an immutable audit trail; this
// component never mutates an existing note, it only appends new ones.
//
// Per DESIGN.md "Timeline note entry": meta (author / timestamp /
// status-at-write) in stone-500 JetBrains Mono, body in stone-700, a small
// status-at-write dot in the matching status colour. The add-note field and
// submit are fully keyboard operable with a 2px amber-500 focus ring (NFR-004,
// WCAG 2.1 AA). The sentinel warning is derived reactively from the returned
// notes' author.isSentinel, so it stays visible after a sentinel-authored note
// is added (there is no client-side git-identity probe endpoint).

interface NotesRailProps {
  projectId: string;
  benchId: number;
  caseId: string;
  notes: Note[];
}

// Status-at-write dot colour, aligned with the DESIGN.md "Status indicator"
// token mapping. Kept local because no shared testbench status-colour source
// exists yet; when one lands this should reference it.
const STATUS_DOT: Record<CaseStatus, string> = {
  not_started: "bg-stone-400",
  in_progress: "bg-amber-500",
  passed: "bg-green-500",
  failed: "bg-red-500",
  blocked: "bg-stone-700",
};

const STATUS_LABEL: Record<CaseStatus, string> = {
  not_started: "not started",
  in_progress: "in progress",
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function authorLabel(note: Note): string {
  return note.author.isSentinel ? `${note.author.name} (unverified)` : note.author.name;
}

export function NotesRail({ projectId, benchId, caseId, notes }: NotesRailProps) {
  const [text, setText] = useState("");
  const append = useAppendNote();

  const hasSentinelAuthor = notes.some((note) => note.author.isSentinel);
  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !append.isPending;

  function handleSubmit() {
    if (!canSubmit) return;
    append.mutate(
      { projectId, benchId, caseId, text },
      {
        onSuccess: () => setText(""),
      },
    );
  }

  const submitError =
    append.error instanceof ApiError ? append.error.message : append.error?.message;

  return (
    <aside aria-label="Notes" className="flex h-full flex-col gap-4">
      {hasSentinelAuthor && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Git identity is unset, so notes are stamped with a placeholder author. Set{" "}
            <code className="font-mono">user.name</code> and{" "}
            <code className="font-mono">user.email</code> to attribute notes to you.
          </span>
        </div>
      )}

      <ol className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {notes.length === 0 ? (
          <li className="text-sm text-stone-400">No notes yet.</li>
        ) : (
          notes.map((note) => (
            <li
              key={note.id}
              className="rounded-lg px-2 py-1.5 transition-colors hover:bg-stone-50"
            >
              <div className="flex items-center gap-2 font-mono text-xs text-stone-500">
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[note.statusAtWrite]}`}
                  aria-hidden="true"
                />
                <span>{authorLabel(note)}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={note.timestamp}>{formatTimestamp(note.timestamp)}</time>
                <span aria-hidden="true">·</span>
                <span>{STATUS_LABEL[note.statusAtWrite]}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700">{note.text}</p>
            </li>
          ))
        )}
      </ol>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <TextField value={text} onChange={setText} className="flex flex-col gap-1">
          <Label className="text-xs font-medium text-stone-600">Add a note</Label>
          <TextArea
            rows={3}
            placeholder="Append an immutable note"
            className="w-full resize-y rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500"
          />
        </TextField>
        {submitError && (
          <p role="alert" className="text-xs text-red-600">
            {submitError}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            isDisabled={!canSubmit}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-stone-950 outline-none transition-colors not-disabled:hover:bg-amber-400 not-disabled:active:bg-amber-600 disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            {append.isPending ? "Adding…" : "Add note"}
          </Button>
        </div>
      </form>
    </aside>
  );
}
