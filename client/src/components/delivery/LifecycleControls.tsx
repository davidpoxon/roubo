import type { ReactNode } from "react";
import { DialogTrigger } from "react-aria-components";
import type { Bench } from "@roubo/shared";
import type { DeliveryCrossCheckResponse } from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectApprovalRefusal, selectLifecycleAction } from "@roubo/shared/delivery-selectors";
import { crossCheckBlockedClassesOf } from "../../lib/api";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import Dialog, { DIALOG_ACTIONS_CLASS } from "../ui/Dialog";
import {
  useApproveDelivery,
  useLifecycleControl,
  useResumeDelivery,
} from "../../hooks/useDelivery";

// The delivery's lifecycle controls (SB-FR-022, SB-FR-034): Pause, Wind down,
// Resume and Approve. Each is enabled exactly in the lifecycle states its route
// takes, read through the same shared selectors, so a button and the route's
// 409 never disagree. Wind down asks first in a DESIGN.md Dialog (one decision,
// the consequential action last); React Aria traps the focus in it and returns
// it to Wind down on close. Resume launches the session again with the
// record's resume argument; the others write a control to the outbox, and the
// health chip follows the session's `lifecycle.changed`. A blocking class of
// the bench's last cross-check holds Approve back (SB-FR-029), and the reason
// beneath it names the class; so does a 409 CROSSCHECK_BLOCKED that the route
// answers for a class the view had not read yet, in the same place. The cost
// view passes its title as `heading` (#1623): the buttons then close the title
// row, and the reason and any error sit under it.

export default function LifecycleControls({
  bench,
  snapshot,
  sessionStartBlocked,
  crossCheck,
  heading,
}: {
  bench: Bench;
  snapshot: DeliverySnapshot;
  // True while the server would refuse a new session: the bench's own session
  // runs, or the bench is clearing or in error.
  sessionStartBlocked: boolean;
  // The bench's last cross-check, when the view has read it.
  crossCheck?: DeliveryCrossCheckResponse | undefined;
  // What opens the row before the buttons, such as the view's title.
  heading?: ReactNode;
}) {
  const control = useLifecycleControl(bench.projectId, bench.id);
  const resume = useResumeDelivery(bench.projectId, bench.id);
  const approve = useApproveDelivery(bench.projectId, bench.id);
  const pause = selectLifecycleAction(snapshot, "pause");
  const windDown = selectLifecycleAction(snapshot, "wind-down");
  const resumable = selectLifecycleAction(snapshot, "resume");
  const refusal = selectApprovalRefusal(snapshot, crossCheck?.disagreements);
  // The route's own CROSSCHECK_BLOCKED, shown in place of the generic error.
  const blockedClasses = approve.isError ? crossCheckBlockedClassesOf(approve.error) : undefined;
  const reason =
    refusal !== null
      ? { code: refusal.code, text: refusal.reason }
      : blockedClasses !== undefined
        ? { code: "CROSSCHECK_BLOCKED", text: approve.error?.message ?? "" }
        : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {heading}
        <section
          data-testid="delivery-lifecycle-controls"
          aria-label="Lifecycle"
          className="flex flex-wrap items-center gap-2"
        >
          <Button
            onPress={() => control.mutate("pause")}
            isDisabled={control.isPending || !pause.available}
          >
            Pause
          </Button>
          <DialogTrigger>
            <Button isDisabled={control.isPending || !windDown.available}>Wind down</Button>
            <Dialog title="Wind down the delivery?" role="alertdialog" isDismissable>
              {({ close }) => (
                <>
                  <p className="text-13 text-text-body">
                    The session finishes the unit it is on and starts no other. Resume the delivery
                    to go on later.
                  </p>
                  <div className={DIALOG_ACTIONS_CLASS}>
                    <Button onPress={close}>Cancel</Button>
                    <Button
                      variant="danger"
                      onPress={() => {
                        control.mutate("wind-down");
                        close();
                      }}
                    >
                      Confirm wind down
                    </Button>
                  </div>
                </>
              )}
            </Dialog>
          </DialogTrigger>
          <Button
            onPress={() => resume.mutate()}
            isDisabled={resume.isPending || sessionStartBlocked || !resumable.available}
          >
            Resume
          </Button>
          <Button
            onPress={() => approve.mutate()}
            isDisabled={approve.isPending || refusal !== null}
            aria-describedby={reason !== null ? "delivery-approve-reason" : undefined}
          >
            Approve
          </Button>
        </section>
      </div>
      {reason !== null && (
        <p
          id="delivery-approve-reason"
          data-testid="delivery-approve-reason"
          data-code={reason.code}
          className="text-12 text-text-secondary"
        >
          {reason.text}
        </p>
      )}
      {control.isError && (
        <Callout role="alert" title="The lifecycle control was not sent">
          {control.error.message}
        </Callout>
      )}
      {resume.isError && (
        <Callout role="alert" title="The delivery session did not start">
          {resume.error.message}
        </Callout>
      )}
      {approve.isError && blockedClasses === undefined && (
        <Callout role="alert" title="The approval was not sent">
          {approve.error.message}
        </Callout>
      )}
    </div>
  );
}
