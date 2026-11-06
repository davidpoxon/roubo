import { DialogTrigger } from "react-aria-components";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectApprovalRefusal, selectLifecycleAction } from "@roubo/shared/delivery-selectors";
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
// health chip follows the session's `lifecycle.changed`.

export default function LifecycleControls({
  bench,
  snapshot,
  sessionStartBlocked,
}: {
  bench: Bench;
  snapshot: DeliverySnapshot;
  // True while the server would refuse a new session: the bench's own session
  // runs, or the bench is clearing or in error.
  sessionStartBlocked: boolean;
}) {
  const control = useLifecycleControl(bench.projectId, bench.id);
  const resume = useResumeDelivery(bench.projectId, bench.id);
  const approve = useApproveDelivery(bench.projectId, bench.id);
  const pause = selectLifecycleAction(snapshot, "pause");
  const windDown = selectLifecycleAction(snapshot, "wind-down");
  const resumable = selectLifecycleAction(snapshot, "resume");
  const refusal = selectApprovalRefusal(snapshot);

  return (
    <>
      <section
        data-testid="delivery-lifecycle-controls"
        aria-label="Lifecycle"
        className="flex flex-wrap gap-2"
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
                  The session finishes the unit it is on and starts no other. Resume the delivery to
                  go on later.
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
          aria-describedby={refusal !== null ? "delivery-approve-reason" : undefined}
        >
          Approve
        </Button>
      </section>
      {refusal !== null && (
        <p
          id="delivery-approve-reason"
          data-testid="delivery-approve-reason"
          className="text-12 text-text-secondary"
        >
          {refusal.reason}
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
      {approve.isError && (
        <Callout role="alert" title="The approval was not sent">
          {approve.error.message}
        </Callout>
      )}
    </>
  );
}
