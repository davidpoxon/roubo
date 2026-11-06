import { useState } from "react";
import { Label, TextArea, TextField } from "react-aria-components";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  selectBoundaryPanel,
  selectSteeringNotes,
  type BoundaryQueueItem,
  type DeliveryBoundary,
  type SteeringNoteView,
} from "@roubo/shared/delivery-selectors";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { FIELD_LABEL_CLASS, INPUT_CLASS } from "../ui/styles";
import { useSteeringNote } from "../../hooks/useDelivery";

// The boundary panel and the steering composer of the Delivery tab (SB-FR-016,
// SB-FR-017). The panel always names the next unit boundary and lists every
// steering note and role change queued for it, from the outbox the snapshot
// carries. The composer sends a steering note for that boundary; the note shows
// queued until the session reads it back (a steering.added that names its
// control_seq), and only then applied, with the read-back text. A boundary
// that passes without a read-back leaves the note queued. Each note is the
// Steering note component of DESIGN.md: a state badge, a mono line naming the
// boundary it lands at, the note, and the read-back once it exists; an applied
// note dims and keeps its read-back. Every text renders as a React text node.

function boundaryText(boundary: DeliveryBoundary | null): string {
  if (boundary === null) return "No unit boundary is ahead";
  return `${boundary.unitId} ${boundary.kind === "finish" ? "finishes" : "starts"}`;
}

function StateBadge({ label }: { label: string }) {
  return (
    <span
      data-testid="steering-note-state"
      className="rounded-chip bg-bg-hover px-1.5 py-0.5 text-11 font-medium text-text-secondary"
    >
      {label}
    </span>
  );
}

function SteeringNoteRow({
  note,
  appliesAt,
  state,
  readBack,
  controlSeq,
}: {
  note: string;
  appliesAt: string | null;
  state: SteeringNoteView["state"];
  readBack: string | null;
  controlSeq: number;
}) {
  return (
    <li
      data-testid={`steering-note-${controlSeq}`}
      data-state={state}
      className={`animate-rise-in space-y-1 rounded-card border border-border bg-bg-surface p-2 ${
        state === "queued" ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge label={state} />
        <span className="font-mono text-11 text-text-secondary">
          {appliesAt === null
            ? "applies at the next boundary"
            : `applies at the next boundary · ${appliesAt}`}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-13 text-text-primary">{note}</p>
      {readBack !== null && (
        <p data-testid="steering-note-read-back" className="text-12 text-text-secondary">
          Read-back: {readBack}
        </p>
      )}
    </li>
  );
}

function QueuedItem({ item }: { item: BoundaryQueueItem }) {
  if (item.kind === "steering-note") {
    return (
      <SteeringNoteRow
        controlSeq={item.controlSeq}
        note={item.note}
        appliesAt={item.appliesAt}
        state="queued"
        readBack={null}
      />
    );
  }
  return (
    <li
      data-testid={`boundary-role-change-${item.controlSeq}`}
      className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-bg-surface p-2"
    >
      <span className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text">
        pending · next boundary
      </span>
      <span className="font-mono text-12 text-text-body">
        {item.role}: {item.tier}
      </span>
    </li>
  );
}

function SteeringComposer({
  projectId,
  benchId,
  boundary,
}: {
  projectId: string;
  benchId: number;
  boundary: DeliveryBoundary | null;
}) {
  const [text, setText] = useState("");
  const send = useSteeringNote(projectId, benchId);
  const disabled = boundary === null;
  const canSend = !disabled && !send.isPending && text.trim().length > 0;
  return (
    <div className="space-y-2">
      <form
        data-testid="steering-composer"
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSend || boundary === null) return;
          send.mutate({ text, appliesAt: boundary.unitId }, { onSuccess: () => setText("") });
        }}
      >
        <TextField
          value={text}
          onChange={setText}
          isDisabled={disabled}
          className="flex flex-1 flex-col gap-1"
        >
          <Label className={FIELD_LABEL_CLASS}>Steering note</Label>
          <TextArea rows={2} className={INPUT_CLASS} />
        </TextField>
        <Button type="submit" isDisabled={!canSend}>
          Send note
        </Button>
      </form>
      {send.isError && (
        <Callout role="alert" title="The steering note was not sent">
          {send.error.message}
        </Callout>
      )}
    </div>
  );
}

export default function BoundaryPanel({
  projectId,
  benchId,
  snapshot,
}: {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
}) {
  const { boundary, queued } = selectBoundaryPanel(snapshot);
  const settled = selectSteeringNotes(snapshot).filter((note) => note.state !== "queued");
  return (
    <div className="space-y-3">
      <section data-testid="delivery-boundary-panel" aria-label="Next boundary" className="space-y-2">
        <h3 className="text-13 font-medium text-text-primary">Next boundary</h3>
        <p data-testid="boundary-name" className="font-mono text-12 text-text-body">
          {boundaryText(boundary)}
        </p>
        {queued.length === 0 ? (
          <p data-testid="boundary-queue-empty" className="text-12 text-text-secondary">
            Nothing is queued for this boundary.
          </p>
        ) : (
          <ul
            data-testid="boundary-queue"
            aria-label="Queued for the next boundary"
            className="space-y-2"
          >
            {queued.map((item) => (
              <QueuedItem key={item.controlSeq} item={item} />
            ))}
          </ul>
        )}
      </section>

      <SteeringComposer projectId={projectId} benchId={benchId} boundary={boundary} />

      {settled.length > 0 && (
        <ul
          data-testid="steering-notes-settled"
          aria-label="Steering notes read back"
          className="space-y-2"
        >
          {settled.map((note) => (
            <SteeringNoteRow
              key={note.controlSeq}
              controlSeq={note.controlSeq}
              note={note.note}
              appliesAt={note.appliesAt}
              state={note.state}
              readBack={note.readBack}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
